const Campaign = require('../models/Campaign');
const Agent = require('../models/Agent');
const User = require('../models/User');
const CallLog = require('../models/CallLog');
const twilio = require('twilio');

class CampaignWorker {
  constructor() {
    this.intervalId = null;
    this.isRunning = false;
    this.activeCallCount = 0;
    this.maxConcurrentCalls = process.env.MAX_CONCURRENT_CALLS || 5;
    this.delayBetweenCalls = process.env.DELAY_BETWEEN_CALLS || 2000; // ms
  }

  start() {
    console.log('🚀 Starting Campaign Background Worker...');
    // Poll every 10 seconds checking for pending numbers in running campaigns
    this.intervalId = setInterval(() => this.processCampaigns(), 10000);
    console.log(`⚙️ Max concurrent calls: ${this.maxConcurrentCalls}`);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      console.log('🛑 Campaign Background Worker stopped.');
    }
  }

  getTwilioClient(user) {
    const sid = user?.settings?.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID;
    const token = user?.settings?.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new Error('Twilio credentials not configured');
    return twilio(sid, token);
  }

  async processCampaigns() {
    if (this.isRunning) return; // Prevent overlapping runs
    this.isRunning = true;

    try {
      // Find all running campaigns
      const activeCampaigns = await Campaign.find({ status: 'running' })
        .populate('agentId')
        .populate('userId');

      for (const campaign of activeCampaigns) {
        // Check if we've reached max concurrent calls
        if (this.activeCallCount >= this.maxConcurrentCalls) {
          console.log(
            `⏸️  Campaign ${campaign._id}: Waiting... (${this.activeCallCount}/${this.maxConcurrentCalls} calls active)`
          );
          break; // Don't process more campaigns if at limit
        }

        // Find the first pending number
        const pendingNumberIndex = campaign.numbers.findIndex(n => n.status === 'pending');
        
        if (pendingNumberIndex === -1) {
          // Check if all numbers are completed
          const allComplete = campaign.numbers.every(
            n => ['completed', 'failed', 'no-answer', 'declined'].includes(n.status)
          );
          
          if (allComplete) {
            // Calculate campaign statistics
            const completed = campaign.numbers.filter(n => n.status === 'completed').length;
            const failed = campaign.numbers.filter(n => n.status === 'failed').length;
            const noAnswer = campaign.numbers.filter(n => n.status === 'no-answer').length;
            
            campaign.status = 'completed';
            campaign.completedAt = new Date();
            campaign.statistics = {
              totalNumbers: campaign.numbers.length,
              completed,
              failed,
              noAnswer,
              successRate: Math.round((completed / campaign.numbers.length) * 100),
            };
            await campaign.save();
            console.log(`✅ Campaign ${campaign.name} completed: ${completed}/${campaign.numbers.length} successful`);
          }
          continue;
        }

        const numberRecord = campaign.numbers[pendingNumberIndex];
        numberRecord.status = 'calling';
        await campaign.save(); // Save calling state to prevent duplicate calls

        // Dispatch call with error handling
        this.dispatchCall(campaign, numberRecord, pendingNumberIndex);

        // Delay before next call
        await this.delay(this.delayBetweenCalls);
      }
    } catch (err) {
      console.error('[CampaignWorker] processing error:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  async dispatchCall(campaign, numberRecord, index) {
    try {
      const user = campaign.userId;
      const fromNumber = user?.settings?.twilioPhoneNumber || process.env.TWILIO_PHONE_NUMBER;
      
      if (!fromNumber) {
        throw new Error('No Twilio phone number configured');
      }

      const client = this.getTwilioClient(user);
      const to = numberRecord.phone;
      const agent = campaign.agentId;

      // Increment active calls
      this.activeCallCount++;
      console.log(`📞 Dispatching call to ${to} (${this.activeCallCount}/${this.maxConcurrentCalls} active)`);

      const call = await client.calls.create({
        to,
        from: fromNumber,
        url: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/outbound-connect?agentId=${agent._id}&userId=${user._id}&campaignId=${campaign._id}`,
        statusCallback: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        machineDetection: 'Enable', // Detect answering machines
        machineDetectionTimeout: 5000,
        asyncAmd: 'true', // Non-blocking AMD detection
        asyncAmdStatusCallback: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/amd-callback`,
        asyncAmdStatusCallbackMethod: 'POST',
        record: process.env.RECORD_CALLS === 'true', // Enable recording if configured
        recordingChannels: 'mono',
        recordingStatusCallback: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/recording`,
      });

      // Log the call
      const callLog = await CallLog.create({
        userId: user._id,
        agentId: agent._id,
        agentName: agent.name,
        callSid: call.sid,
        fromNumber,
        toNumber: to,
        direction: 'outbound',
        status: 'initiated',
        campaign: campaign._id,
        startTime: new Date(),
        metadata: {
          campaignName: campaign.name,
          campaignId: campaign._id.toString(),
        },
      });

      // Update campaign record
      campaign.numbers[index].status = 'in-progress';
      campaign.numbers[index].callSid = call.sid;
      campaign.numbers[index].callLogId = callLog._id;
      campaign.numbers[index].startTime = new Date();
      await campaign.save();

      console.log(`✅ Call dispatched to ${to} (SID: ${call.sid})`);

    } catch (callError) {
      this.activeCallCount--;
      console.error(`❌ Call failed to ${numberRecord.phone}:`, callError.message);
      
      campaign.numbers[index].status = 'failed';
      campaign.numbers[index].error = callError.message;
      campaign.numbers[index].errorCode = callError.code;
      campaign.numbers[index].failedAt = new Date();
      
      await campaign.save();

      // Log failed call
      await CallLog.create({
        userId: campaign.userId._id,
        agentId: campaign.agentId._id,
        agentName: campaign.agentId.name,
        fromNumber: process.env.TWILIO_PHONE_NUMBER,
        toNumber: numberRecord.phone,
        direction: 'outbound',
        status: 'failed',
        campaign: campaign._id,
        startTime: new Date(),
        endTime: new Date(),
        duration: 0,
        error: callError.message,
      });
    }
  }

  // Handle call completion and update records
  async handleCallCompletion({ callSid, status, duration, recordingUrl, transcript }) {
    try {
      const callLog = await CallLog.findOne({ callSid });
      if (!callLog) {
        console.warn(`⚠️ Call log not found for SID: ${callSid}`);
        return;
      }

      // Update call log
      callLog.status = status;
      callLog.endTime = new Date();
      callLog.duration = duration || 0;
      callLog.recordingUrl = recordingUrl;
      callLog.transcript = transcript;
      await callLog.save();

      // Update campaign record
      if (callLog.campaign) {
        const campaign = await Campaign.findById(callLog.campaign);
        if (campaign) {
          const numberRecord = campaign.numbers.find(n => n.callSid === callSid);
          if (numberRecord) {
            numberRecord.status = status === 'completed' ? 'completed' : 'failed';
            numberRecord.duration = duration || 0;
            numberRecord.endTime = new Date();
            numberRecord.recordingUrl = recordingUrl;
            await campaign.save();
          }
        }
      }

      // Decrement active calls
      this.activeCallCount = Math.max(0, this.activeCallCount - 1);
      console.log(`📊 Call completed: ${status} (${this.activeCallCount} active)`);

    } catch (error) {
      console.error('Error updating call completion:', error.message);
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new CampaignWorker();
