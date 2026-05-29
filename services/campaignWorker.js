/**
 * Campaign Worker v2 — production-grade outbound dialer.
 *
 * Improvements over v1:
 *  • Timezone-aware dialing window (only dial during configured hours/days
 *    in the campaign's IANA timezone)
 *  • Retry policy with fixed/exponential backoff (per-number nextAttempt
 *    tracking lives on Campaign.numbers[i])
 *  • Concurrency cap (per campaign throttle, with a global fallback)
 *  • Calls-per-minute throttle to avoid carrier spam-flagging
 *  • Do-Not-Call list — skipped numbers get status=dnc-skipped
 *  • fromNumbers rotation — round-robin sender pool
 *  • Variable substitution into agent.firstMessage / systemPrompt for
 *    personalised outreach (e.g. "Hi {{name}}, calling about {{product}}")
 */

const Campaign = require('../models/Campaign');
const CallLog = require('../models/CallLog');
const twilio = require('twilio');

const TICK_MS = Number(process.env.CAMPAIGN_TICK_MS || 5000);
const GLOBAL_MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_CALLS || 25);

class CampaignWorker {
  constructor() {
    this.intervalId = null;
    this.isRunning = false;
    this.activeCallCount = 0;
    this.cpmCounters = new Map(); // campaignId -> { windowStartedAt, count }
    this.fromNumberRotor = new Map(); // campaignId -> next index
  }

  start() {
    console.log('🚀 Starting Campaign Worker v2...');
    this.intervalId = setInterval(() => this.tick(), TICK_MS);
    console.log(`⚙️  Global concurrent cap: ${GLOBAL_MAX_CONCURRENT} | Tick: ${TICK_MS}ms`);
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    console.log('🛑 Campaign Worker stopped.');
  }

  getTwilioClient(user) {
    const sid = user?.settings?.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID;
    const token = user?.settings?.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('Twilio credentials not configured');
    return twilio(sid, token);
  }

  /**
   * Is the given Date inside the campaign's configured dialing window?
   * Uses Intl.DateTimeFormat with the campaign timezone — no extra deps.
   */
  isWithinDialingWindow(campaign, now = new Date()) {
    const sched = campaign.schedule || {};
    const tz = sched.timezone || 'Asia/Kolkata';
    const startH = sched.dailyStartHour ?? 9;
    const endH   = sched.dailyEndHour   ?? 19;
    const allowedDays = sched.daysOfWeek && sched.daysOfWeek.length > 0 ? sched.daysOfWeek : null;

    let hour, dow;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        weekday: 'short',
        hour12: false,
      }).formatToParts(now);
      hour = Number(parts.find(p => p.type === 'hour').value);
      const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      dow = dayMap[parts.find(p => p.type === 'weekday').value];
    } catch (e) {
      console.error('[CampaignWorker] Timezone parse failed:', e.message);
      return true; // fail-open — better to dial than stall the whole campaign
    }

    if (allowedDays && !allowedDays.includes(dow)) return false;
    return hour >= startH && hour < endH;
  }

  /**
   * Calls-per-minute gate. Returns true if a new dial is allowed this second.
   */
  underCpmCap(campaign) {
    const cap = campaign.throttle?.callsPerMinute || 30;
    const now = Date.now();
    let bucket = this.cpmCounters.get(campaign._id.toString());
    if (!bucket || now - bucket.windowStartedAt >= 60000) {
      bucket = { windowStartedAt: now, count: 0 };
      this.cpmCounters.set(campaign._id.toString(), bucket);
    }
    if (bucket.count >= cap) return false;
    bucket.count += 1;
    return true;
  }

  pickFromNumber(campaign, fallback) {
    const pool = (campaign.fromNumbers && campaign.fromNumbers.length > 0)
      ? campaign.fromNumbers
      : (fallback ? [fallback] : []);
    if (pool.length === 0) return null;
    const key = campaign._id.toString();
    const idx = (this.fromNumberRotor.get(key) || 0) % pool.length;
    this.fromNumberRotor.set(key, idx + 1);
    return pool[idx];
  }

  /**
   * Find the next number eligible to be dialed:
   *  - status === 'pending', or
   *  - status === 'retry-pending' with nextAttempt <= now
   */
  pickNextNumber(campaign, now = new Date()) {
    return campaign.numbers.findIndex(n => {
      if (n.status === 'pending') return true;
      if (n.status === 'retry-pending' && (!n.nextAttempt || new Date(n.nextAttempt) <= now)) return true;
      return false;
    });
  }

  isOnDncList(campaign, phone) {
    if (!campaign.dncNumbers || campaign.dncNumbers.length === 0) return false;
    const norm = (s) => String(s || '').replace(/[^\d+]/g, '');
    const target = norm(phone);
    return campaign.dncNumbers.some(d => norm(d) === target);
  }

  computeBackoffMinutes(policy, attemptNum) {
    const base = policy?.backoffMinutes || 30;
    if (policy?.backoffStrategy === 'exponential') {
      return base * Math.pow(2, Math.max(0, attemptNum - 1));
    }
    return base;
  }

  async tick() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const campaigns = await Campaign.find({ status: 'running' })
        .populate('agentId')
        .populate('userId');

      const now = new Date();
      for (const campaign of campaigns) {
        if (this.activeCallCount >= GLOBAL_MAX_CONCURRENT) break;
        if (!campaign.agentId || !campaign.userId) continue;

        // Schedule check
        if (!this.isWithinDialingWindow(campaign, now)) continue;

        // Per-campaign concurrency cap
        const perCampaignCap = campaign.throttle?.maxConcurrentCalls || 5;
        const inFlight = campaign.numbers.filter(n =>
          n.status === 'calling' || n.status === 'in-progress'
        ).length;
        if (inFlight >= perCampaignCap) continue;

        // Calls-per-minute throttle
        if (!this.underCpmCap(campaign)) continue;

        const idx = this.pickNextNumber(campaign, now);
        if (idx === -1) {
          // Nothing dialable — campaign auto-completes via pre-save hook when terminal.
          continue;
        }

        const numberRecord = campaign.numbers[idx];

        // DNC check
        if (this.isOnDncList(campaign, numberRecord.phone)) {
          numberRecord.status = 'dnc-skipped';
          numberRecord.error = 'on_dnc_list';
          await campaign.save();
          continue;
        }

        // Lock the row before dispatching
        numberRecord.status = 'calling';
        numberRecord.attempts = (numberRecord.attempts || 0) + 1;
        numberRecord.lastAttempt = new Date();
        await campaign.save();

        this.dispatchCall(campaign, idx)
          .catch(e => console.error('[CampaignWorker] dispatch error:', e.message));
      }
    } catch (err) {
      console.error('[CampaignWorker] tick error:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  async dispatchCall(campaign, index) {
    const numberRecord = campaign.numbers[index];
    const user  = campaign.userId;
    const agent = campaign.agentId;

    try {
      const fromNumber = this.pickFromNumber(campaign, user?.settings?.twilioPhoneNumber || process.env.TWILIO_PHONE_NUMBER);
      if (!fromNumber) throw new Error('No Twilio phone number configured');

      const client = this.getTwilioClient(user);
      const to = numberRecord.phone;

      this.activeCallCount++;
      console.log(`📞 Dispatching ${to} from ${fromNumber} (attempt ${numberRecord.attempts}, ${this.activeCallCount}/${GLOBAL_MAX_CONCURRENT} active)`);

      // Variables for personalisation (consumed by the voice pipeline via callParams).
      const callVars = {
        ...(numberRecord.variables || {}),
        campaignId: campaign._id.toString(),
        attempt: numberRecord.attempts,
      };

      const baseUrl = process.env.BACKEND_URL || 'http://localhost:5000';
      const qs = new URLSearchParams({
        agentId:    agent._id.toString(),
        userId:     user._id.toString(),
        campaignId: campaign._id.toString(),
        vars:       Buffer.from(JSON.stringify(callVars)).toString('base64'),
      }).toString();

      const call = await client.calls.create({
        to,
        from: fromNumber,
        url: `${baseUrl}/api/twilio/outbound-connect?${qs}`,
        statusCallback: `${baseUrl}/api/twilio/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        machineDetection: 'Enable',
        machineDetectionTimeout: 5000,
        asyncAmd: 'true',
        asyncAmdStatusCallback: `${baseUrl}/api/twilio/amd-callback`,
        asyncAmdStatusCallbackMethod: 'POST',
        record: process.env.RECORD_CALLS === 'true',
        recordingChannels: 'mono',
        recordingStatusCallback: `${baseUrl}/api/twilio/recording`,
      });

      const callLog = await CallLog.create({
        userId: user._id,
        agentId: agent._id,
        agentName: agent.name,
        callSid: call.sid,
        fromNumber,
        toNumber: to,
        direction: 'outbound',
        status: 'ongoing',
        startTime: new Date(),
      });

      campaign.numbers[index].status = 'in-progress';
      campaign.numbers[index].callSid = call.sid;
      campaign.numbers[index].callLogId = callLog._id;
      campaign.numbers[index].fromNumber = fromNumber;
      campaign.numbers[index].startTime = new Date();
      await campaign.save();

      console.log(`✅ Dispatched ${to} (SID: ${call.sid}, attempts: ${numberRecord.attempts})`);
    } catch (callError) {
      this.activeCallCount = Math.max(0, this.activeCallCount - 1);
      console.error(`❌ Call failed to ${numberRecord.phone}:`, callError.message);
      await this.handleNumberFailure(campaign, index, callError);
    }
  }

  /**
   * Decide whether to retry, mark terminal failure, or skip.
   */
  async handleNumberFailure(campaign, index, err) {
    const policy = campaign.retryPolicy || {};
    const maxAttempts = policy.maxAttempts || 3;
    const numberRecord = campaign.numbers[index];

    numberRecord.error = err.message || 'unknown';
    numberRecord.errorCode = err.code || '';
    numberRecord.failedAt = new Date();

    if ((numberRecord.attempts || 0) < maxAttempts) {
      const delayMin = this.computeBackoffMinutes(policy, numberRecord.attempts);
      numberRecord.status = 'retry-pending';
      numberRecord.nextAttempt = new Date(Date.now() + delayMin * 60 * 1000);
      console.log(`🔁 Will retry ${numberRecord.phone} in ${delayMin}min (attempt ${numberRecord.attempts}/${maxAttempts})`);
    } else {
      numberRecord.status = 'failed';
      console.log(`💀 Giving up on ${numberRecord.phone} after ${numberRecord.attempts} attempts`);
      // Log the terminal failure
      await CallLog.create({
        userId: campaign.userId._id,
        agentId: campaign.agentId._id,
        agentName: campaign.agentId.name,
        fromNumber: numberRecord.fromNumber || process.env.TWILIO_PHONE_NUMBER,
        toNumber: numberRecord.phone,
        direction: 'outbound',
        status: 'failed',
        startTime: new Date(),
        endTime: new Date(),
        duration: 0,
      }).catch(() => {});
    }
    await campaign.save();
  }

  /**
   * Hook called by Twilio status callback when a call completes/fails.
   * Routes terminal-but-retryable statuses (busy, no-answer) into the
   * retry pipeline if the campaign's retryOnStatuses includes them.
   */
  async handleCallCompletion({ callSid, status, duration, recordingUrl, transcript }) {
    try {
      const callLog = await CallLog.findOne({ callSid });
      if (!callLog) return;

      callLog.status = status === 'completed' ? 'completed' : 'failed';
      callLog.endTime = new Date();
      callLog.duration = duration || 0;
      if (recordingUrl) callLog.recordingUrl = recordingUrl;
      if (transcript) callLog.transcript = transcript;
      await callLog.save();

      const campaign = await Campaign.findOne({ 'numbers.callSid': callSid });
      if (!campaign) {
        this.activeCallCount = Math.max(0, this.activeCallCount - 1);
        return;
      }

      const idx = campaign.numbers.findIndex(n => n.callSid === callSid);
      if (idx === -1) {
        this.activeCallCount = Math.max(0, this.activeCallCount - 1);
        return;
      }

      const policy = campaign.retryPolicy || {};
      const maxAttempts = policy.maxAttempts || 3;
      const retryStatuses = policy.retryOnStatuses && policy.retryOnStatuses.length > 0
        ? policy.retryOnStatuses
        : ['no-answer', 'busy', 'failed'];

      const number = campaign.numbers[idx];
      number.duration = duration || 0;
      number.endTime = new Date();
      if (recordingUrl) number.recordingUrl = recordingUrl;

      if (status === 'completed') {
        number.status = 'completed';
      } else if (retryStatuses.includes(status) && (number.attempts || 0) < maxAttempts) {
        const delayMin = this.computeBackoffMinutes(policy, number.attempts);
        number.status = 'retry-pending';
        number.nextAttempt = new Date(Date.now() + delayMin * 60 * 1000);
        console.log(`🔁 Retry ${number.phone} after ${status} in ${delayMin}min`);
      } else {
        number.status = 'failed';
        number.error = status;
      }

      await campaign.save();
      this.activeCallCount = Math.max(0, this.activeCallCount - 1);
      console.log(`📊 Call ${status} → ${number.phone} (active: ${this.activeCallCount})`);
    } catch (e) {
      console.error('[CampaignWorker] completion error:', e.message);
    }
  }

  delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = new CampaignWorker();
