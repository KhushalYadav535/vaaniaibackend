/**
 * Plivo Telephony Routes
 *
 * Handles real phone calls via Plivo:
 * - POST /api/plivo/inbound              → Inbound call webhook (Plivo calls this)
 * - POST /api/plivo/outbound-connect     → Outbound call XML-ML
 * - POST /api/plivo/gather-response      → Speech gathering responses
 * - POST /api/plivo/status               → Call status / hangup updates
 * - POST /api/plivo/hangup               → Hangup event webhook
 *
 * Number Management (authenticated):
 * - GET  /api/plivo/available-numbers    → Search available numbers
 * - POST /api/plivo/buy-number           → Purchase a number
 * - DELETE /api/plivo/release-number/:number → Release a number
 * - POST /api/plivo/make-call            → Initiate outbound call
 * - GET  /api/plivo/call/:callUuid       → Get call details
 * - POST /api/plivo/call/:callUuid/hangup → Hang up active call
 * - POST /api/plivo/test-credentials    → Validate Plivo credentials
 */

const express = require('express');
const router  = express.Router();
const plivo   = require('plivo');

const Agent        = require('../models/Agent');
const PhoneNumber  = require('../models/PhoneNumber');
const CallLog      = require('../models/CallLog');
const User         = require('../models/User');
const Campaign     = require('../models/Campaign');
const voicePipeline    = require('../services/voicePipeline');
const toolExecutor     = require('../services/toolExecutor');
const plivoService     = require('../services/plivoService');
const ttsService       = require('../services/ttsService');
const notificationService = require('../services/notificationService');
const campaignWorker  = require('../services/campaignWorker');
const { protect } = require('../middleware/auth');
const crypto = require('crypto');

// ─── In-memory TTS audio cache (token → { buffer, contentType, expires }) ───
// Audio is generated on-demand, stored here, served via GET /tts-audio/:token
// Tokens expire after 5 minutes to avoid memory leaks
const ttsAudioCache = new Map();

function storeTtsAudio(buffer, contentType = 'audio/mpeg') {
  const token = crypto.randomBytes(16).toString('hex');
  ttsAudioCache.set(token, {
    buffer,
    contentType,
    expires: Date.now() + 5 * 60 * 1000, // 5 min TTL
  });
  // Cleanup expired entries
  for (const [k, v] of ttsAudioCache) {
    if (v.expires < Date.now()) ttsAudioCache.delete(k);
  }
  return token;
}

/**
 * Generate TTS audio using agent's preferred TTS provider, store it,
 * and return a URL that Plivo can fetch via <Play>.
 * Falls back to Plivo's built-in <Speak> if TTS generation fails.
 */
async function getTtsAudioUrl(text, agent, user, baseUrl) {
  try {
    const voiceId   = agent.voice?.voiceId   || 'en-US-JennyNeural';
    const provider  = agent.voice?.provider  || user?.settings?.preferredTts || 'edge-tts';
    const apiKey    = provider === 'eleven-labs'
      ? (user?.settings?.elevenLabsKey || process.env.ELEVENLABS_API_KEY)
      : null;

    const audioBuffer = await ttsService.textToSpeech({
      text,
      voiceId,
      provider,
      apiKey,
      speed: agent.voice?.speed || 1.0,
    });

    if (!audioBuffer || audioBuffer.length === 0) return null;

    const token = storeTtsAudio(audioBuffer, 'audio/mpeg');
    return `${baseUrl}/api/plivo/tts-audio/${token}`;
  } catch (err) {
    console.error('[Plivo TTS] Generation failed, will use <Speak> fallback:', err.message);
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPlivoClient(user) {
  return plivoService.getPlivoClient(user);
}

/** Build Plivo XML response object */
function plivoResponse() {
  return new plivo.Response();
}

/** Map voice IDs to Plivo-supported voices */
function mapVoiceToPlivo(voiceId = '') {
  const voiceMap = {
    'en-US-JennyNeural':   'WOMAN',
    'en-US-GuyNeural':     'MAN',
    'en-US-AriaNeural':    'WOMAN',
    'en-GB-SoniaNeural':   'WOMAN',
    'en-AU-NatashaNeural': 'WOMAN',
    'hi-IN-SwaraNeural':   'WOMAN',
    'hi-IN-MadhurNeural':  'MAN',
  };
  return voiceMap[voiceId] || 'WOMAN';
}

/** Map voice IDs to language codes for Plivo Speak */
function mapVoiceToLanguage(voiceId = '') {
  if (voiceId.startsWith('hi-')) return 'hi-IN';
  if (voiceId.startsWith('en-GB')) return 'en-GB';
  if (voiceId.startsWith('en-AU')) return 'en-AU';
  return 'en-US';
}

// ─── TTS AUDIO SERVE ENDPOINT (Public — Plivo fetches this) ─────────────────

/**
 * GET /api/plivo/tts-audio/:token
 * Serves pre-generated TTS audio (ElevenLabs/Cartesia/Edge) to Plivo via <Play>.
 * Tokens are created by getTtsAudioUrl() and expire after 5 minutes.
 */
router.get('/tts-audio/:token', (req, res) => {
  const entry = ttsAudioCache.get(req.params.token);
  if (!entry || entry.expires < Date.now()) {
    ttsAudioCache.delete(req.params.token);
    return res.status(404).send('Audio not found or expired');
  }
  // Don't delete — Plivo may retry fetching (redirects, partial transfers)
  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Content-Length', entry.buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  res.send(entry.buffer);
});

// ─── INBOUND CALL WEBHOOK ────────────────────────────────────────────────────

/**
 * POST /api/plivo/inbound
 * Plivo calls this URL when someone dials your Plivo number.
 * Set this as the "Answer URL" in your Plivo Application config.
 */
router.post('/inbound', async (req, res) => {
  const response = plivoResponse();

  try {
    const { To, From, CallUUID } = req.body;
    console.log(`📞 Plivo inbound call: ${From} → ${To} (UUID: ${CallUUID})`);

    // Normalize: Plivo may send To as "+912269851801" or "912269851801"
    // DB stores it without leading + (e.g. "912269851801")
    const normalizedTo = To ? To.replace(/^\+/, '') : To;

    // Find the phone number record with assigned agent
    const phoneRecord = await PhoneNumber.findOne({
      number: { $in: [normalizedTo, `+${normalizedTo}`] }
    }).populate('assignedAgent');

    if (!phoneRecord || !phoneRecord.assignedAgent) {
      console.warn(`⚠️  No agent assigned to ${To} (normalized: ${normalizedTo})`);
      const fallback = plivoResponse();
      fallback.addSpeak(
        'Sorry, this number is not configured with an AI agent. Please try again later.',
        { voice: 'WOMAN', language: 'en-US' }
      );
      return res.type('text/xml').send(fallback.toXML());
    }

    const agent    = phoneRecord.assignedAgent;
    const baseUrl  = process.env.BACKEND_URL || 'http://localhost:5000';
    const wsUrl    = baseUrl.replace(/^http/, 'ws'); // https → wss, http → ws

    // ── Realtime Bi-directional Stream (Zoronal/Vapi/Retell style) ──────────
    // Instead of: GetInput (wait 3s) → gather-response → LLM (2-4s latency)
    // We now do: Stream mulaw/8000 → Deepgram live → LLM streaming → mulaw back
    // Target latency: <800ms
    const customParams = JSON.stringify({
      agentId:   String(agent._id),
      callUuid:  CallUUID,
      from:      From,
      to:        To,
      direction: 'inbound',
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream keepCallAlive="true" bidirectional="true" streamTimeout="86400"
          contentType="audio/x-mulaw;rate=8000"
          audioTrack="inbound"
          customParameters='${customParams.replace(/'/g, "&apos;")}'>
    ${wsUrl}/ws/plivo-stream
  </Stream>
</Response>`;

    console.log(`✅ Inbound call ${CallUUID}: returning Stream XML → ${wsUrl}/ws/plivo-stream`);
    res.type('text/xml').send(xml);

  } catch (error) {
    console.error('❌ Plivo inbound webhook error:', error);
    const fallback = plivoResponse();
    fallback.addSpeak('Sorry, an error occurred. Please try again later.');
    res.type('text/xml').send(fallback.toXML());
  }
});


// ─── GATHER RESPONSE ────────────────────────────────────────────────────────

/**
 * POST /api/plivo/gather-response
 * Called after Plivo gathers speech from user
 */
router.post('/gather-response', async (req, res) => {
  const response = plivoResponse();

  try {
    const { callUuid, agentId } = req.query;
    const { Speech, Confidence } = req.body;

    console.log(`🎙️  Plivo speech: "${Speech}" (confidence: ${Confidence}) [${callUuid}]`);

    const callLog = await CallLog.findOne({ callSid: callUuid });
    const agent   = await Agent.findById(agentId);

    if (!callLog || !agent) {
      response.addSpeak('Session not found. Goodbye!');
      response.addHangup();
      return res.type('text/xml').send(response.toXML());
    }

    // Low confidence — ask to repeat
    if (parseFloat(Confidence) < 0.5) {
      const language = mapVoiceToLanguage(agent.voice?.voiceId);
      const baseUrl  = process.env.BACKEND_URL || 'http://localhost:5000';
      const user     = await User.findById(agent.userId);
      const repeatMsg = 'Sorry, I did not understand that clearly. Could you please repeat?';
      const audioUrl  = await getTtsAudioUrl(repeatMsg, agent, user, baseUrl);

      const getInput = response.addGetInput({
        inputType:     'speech',
        speechTimeout:  3,
        action:        `${baseUrl}/api/plivo/gather-response?callUuid=${callUuid}&agentId=${agentId}`,
        method:        'POST',
        language,
        redirect:      false,
      });
      if (audioUrl) {
        getInput.addPlay(audioUrl);
      } else {
        getInput.addSpeak(repeatMsg, { voice: mapVoiceToPlivo(agent.voice?.voiceId), language });
      }
      return res.type('text/xml').send(response.toXML());
    }

    // Check for end call phrases
    const endPhrases = agent.endCallPhrases || ['bye', 'goodbye', 'thanks', 'thank you', 'done'];
    const shouldEnd  = endPhrases.some(phrase =>
      (Speech || '').toLowerCase().includes(phrase.toLowerCase())
    );

    // Save user message
    callLog.transcript.push({
      role:      'user',
      content:   Speech,
      timestamp: new Date(),
      confidence: Confidence,
    });
    await callLog.save();

    if (shouldEnd) {
      const endMsg   = agent.endCallMessage || 'Thank you for calling. Goodbye!';
      const language = mapVoiceToLanguage(agent.voice?.voiceId);
      const baseUrl  = process.env.BACKEND_URL || 'http://localhost:5000';
      const user     = await User.findById(agent.userId);
      const endAudioUrl = await getTtsAudioUrl(endMsg, agent, user, baseUrl);

      if (endAudioUrl) {
        response.addPlay(endAudioUrl);
      } else {
        response.addSpeak(endMsg, { voice: mapVoiceToPlivo(agent.voice?.voiceId), language });
      }
      response.addHangup();

      callLog.status  = 'completed';
      callLog.endTime = new Date();
      await callLog.save();

      return res.type('text/xml').send(response.toXML());
    }

    // Get user settings for LLM
    const user = await User.findById(agent.userId);

    // Process with AI
    const aiResult = await voicePipeline.processText({
      text:         Speech,
      agent,
      history:      callLog.transcript.slice(-10),
      userSettings: user?.settings || {},
    });

    // Execute tools if any
    if (aiResult.toolCalls && aiResult.toolCalls.length > 0) {
      await toolExecutor.executeToolCalls({
        toolCalls:    aiResult.toolCalls,
        agentContext: {
          agentId:    agent._id,
          userId:     agent.userId,
          callUuid,
          fromNumber: callLog.fromNumber,
        },
      }).catch(err => console.error('Tool execution error:', err.message));
    }

    // Save assistant response
    callLog.transcript.push({
      role:      'assistant',
      content:   aiResult.response,
      timestamp: new Date(),
    });
    await callLog.save();

    const language = mapVoiceToLanguage(agent.voice?.voiceId);
    const baseUrl  = process.env.BACKEND_URL || 'http://localhost:5000';

    // Generate high-quality TTS for AI response
    const audioUrl = await getTtsAudioUrl(aiResult.response, agent, user, baseUrl);

    // Continue conversation
    const getInput = response.addGetInput({
      inputType:     'speech',
      speechTimeout:  3,
      action:        `${baseUrl}/api/plivo/gather-response?callUuid=${callUuid}&agentId=${agentId}`,
      method:        'POST',
      language,
      redirect:      false,
    });

    if (audioUrl) {
      getInput.addPlay(audioUrl);
    } else {
      getInput.addSpeak(aiResult.response, { voice: mapVoiceToPlivo(agent.voice?.voiceId), language });
    }

    // Fallback if no input
    response.addSpeak('Are you still there? Goodbye!', { voice: 'WOMAN', language: 'en-US' });
    response.addHangup();

    res.type('text/xml').send(response.toXML());

  } catch (error) {
    console.error('❌ Plivo gather-response error:', error);
    response.addSpeak('Sorry, an error occurred. Please call back later.');
    response.addHangup();
    res.type('text/xml').send(response.toXML());
  }
});

// ─── OUTBOUND CONNECT ────────────────────────────────────────────────────────

/**
 * POST /api/plivo/outbound-connect
 * Called by Plivo when an outbound call is answered.
 * Returns XML-ML for the AI agent conversation.
 */
router.post('/outbound-connect', async (req, res) => {
  const response = plivoResponse();

  try {
    const { agentId, userId, campaignId, vars } = req.query;
    const { CallUUID, AnsweredBy } = req.body;

    console.log(`📤 Plivo outbound answered: ${CallUUID} (AnsweredBy: ${AnsweredBy})`);

    // If machine detected, hang up
    if (AnsweredBy === 'machine') {
      console.log(`🤖 Machine detected for ${CallUUID}, hanging up`);
      const hmr = plivoResponse();
      hmr.addHangup();
      return res.type('text/xml').send(hmr.toXML());
    }

    const agent = await Agent.findById(agentId);
    if (!agent) {
      const err = plivoResponse();
      err.addSpeak('Configuration error. Goodbye!');
      err.addHangup();
      return res.type('text/xml').send(err.toXML());
    }

    // Parse variables for personalisation (kept for later use by plivoStream.js)
    let callVars = {};
    if (vars) {
      try { callVars = JSON.parse(Buffer.from(vars, 'base64').toString()); }
      catch (e) { /* ignore */ }
    }

    const baseUrl = process.env.BACKEND_URL || 'http://localhost:5000';
    const wsUrl   = baseUrl.replace(/^http/, 'ws');

    // ── Realtime Bi-directional Stream (outbound) ──────────────────────────
    const customParams = JSON.stringify({
      agentId:    String(agent._id),
      userId:     String(userId || agent.userId),
      callUuid:   CallUUID,
      campaignId: campaignId || '',
      direction:  'outbound',
      vars:       vars || '',
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream keepCallAlive="true" bidirectional="true" streamTimeout="86400"
          contentType="audio/x-mulaw;rate=8000"
          audioTrack="inbound"
          customParameters='${customParams.replace(/'/g, "&apos;")}'>
    ${wsUrl}/ws/plivo-stream
  </Stream>
</Response>`;

    console.log(`✅ Outbound call ${CallUUID}: returning Stream XML → ${wsUrl}/ws/plivo-stream`);
    res.type('text/xml').send(xml);

  } catch (error) {
    console.error('❌ Plivo outbound-connect error:', error);
    const err = plivoResponse();
    err.addSpeak('Sorry, an error occurred. Goodbye!');
    err.addHangup();
    res.type('text/xml').send(err.toXML());
  }
});

// ─── STATUS / HANGUP WEBHOOKS ────────────────────────────────────────────────

/**
 * POST /api/plivo/status
 * General status callback for call events
 */
router.post('/status', async (req, res) => {
  try {
    const { CallUUID, CallStatus, Duration, From, To } = req.body;
    console.log(`📊 Plivo call status: ${CallUUID} → ${CallStatus}`);

    const statusMap = {
      'completed':  'completed',
      'busy':       'no-answer',
      'no-answer':  'no-answer',
      'failed':     'failed',
      'canceled':   'failed',
      'ringing':    'ringing',
      'answered':   'answered',
      'in-progress': 'answered',
    };

    const updateData = {
      status:  statusMap[CallStatus] || CallStatus,
      endTime: new Date(),
      duration: parseInt(Duration) || 0,
    };

    const callLog = await CallLog.findOneAndUpdate(
      { callSid: CallUUID },
      updateData,
      { new: true }
    );

    // Campaign update on completion
    if (callLog?.campaign) {
      await campaignWorker.handleCallCompletion({
        callSid:  CallUUID,
        status:   statusMap[CallStatus] || CallStatus,
        duration: parseInt(Duration) || 0,
      });
    }

    // Post-call analysis on completion
    if (CallStatus === 'completed' && callLog?.transcript?.length > 0) {
      voicePipeline.analyzeCall(callLog.transcript).then(async (analysis) => {
        if (analysis) {
          const updatedLog = await CallLog.findByIdAndUpdate(callLog._id, {
            summary:          analysis.summary,
            sentiment:        analysis.sentiment,
            emotion:          analysis.emotion,
            metrics:          analysis.metrics,
            actionItems:      analysis.actionItems,
            extractedData:    analysis.extractedData,
            topics:           analysis.topics || [],
            decisions:        analysis.decisions || [],
            customerIntent:   analysis.customerIntent || '',
            urgencyLevel:     analysis.urgencyLevel || '',
            followUpRequired: analysis.followUpRequired || false,
            qa:               { score: analysis.qaScore || 0 },
          }, { new: true });

          // Send notifications
          const agent = await Agent.findById(callLog.agentId);
          if (agent?.postCallActions?.sendSMS || agent?.postCallActions?.sendWhatsApp) {
            const user = await User.findById(callLog.userId);
            notificationService.sendPostCallNotifications({
              callLog: updatedLog,
              agent,
              userSettings: user?.settings || {},
            }).catch(err => console.error('Notification error:', err.message));
          }
        }
      }).catch(err => console.error('Post-call analysis error:', err.message));
    }

    res.sendStatus(204);
  } catch (error) {
    console.error('❌ Plivo status webhook error:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /api/plivo/hangup
 * Hangup event webhook
 */
router.post('/hangup', async (req, res) => {
  try {
    const { CallUUID, HangupCause, Duration } = req.body;
    console.log(`📵 Plivo hangup: ${CallUUID} (${HangupCause}, ${Duration}s)`);

    await CallLog.findOneAndUpdate(
      { callSid: CallUUID },
      {
        status:     'completed',
        endTime:    new Date(),
        duration:   parseInt(Duration) || 0,
        endReason:  HangupCause || 'normal',
      }
    );

    res.sendStatus(204);
  } catch (error) {
    console.error('❌ Plivo hangup webhook error:', error);
    res.sendStatus(500);
  }
});

// ─── AUTHENTICATED MANAGEMENT ROUTES ────────────────────────────────────────

router.use(protect);

/**
 * PATCH /api/plivo/numbers/:numberId/assign
 * Attach an agent to a Plivo phone number (or detach with agentId: null)
 *
 * Body: { agentId }  — set to null to detach
 *
 * Flow:
 *   1. Caller buys a number → PhoneNumber doc saved in DB
 *   2. Caller calls this endpoint with the target agentId
 *   3. Number's assignedAgent is set → inbound calls now route to that agent
 */
router.patch('/numbers/:numberId/assign', async (req, res, next) => {
  try {
    const { agentId } = req.body;

    const phoneRecord = await PhoneNumber.findOne({
      _id:      req.params.numberId,
      userId:   req.effectiveUserId,
      provider: 'plivo',
    });

    if (!phoneRecord) {
      return res.status(404).json({ success: false, message: 'Phone number not found' });
    }

    if (agentId) {
      // Verify agent belongs to this user
      const agent = await Agent.findOne({ _id: agentId, userId: req.effectiveUserId });
      if (!agent) {
        return res.status(404).json({ success: false, message: 'Agent not found' });
      }
      phoneRecord.assignedAgent = agentId;
    } else {
      // Detach — remove assignment
      phoneRecord.assignedAgent = null;
    }

    await phoneRecord.save();

    const populated = await PhoneNumber.findById(phoneRecord._id).populate('assignedAgent', 'name _id');

    console.log(`📌 Plivo number ${phoneRecord.number} ${agentId ? 'assigned to agent ' + agentId : 'detached'}`);

    res.json({
      success: true,
      message: agentId
        ? `Number ${phoneRecord.number} assigned to agent ${populated.assignedAgent?.name}`
        : `Number ${phoneRecord.number} detached from agent`,
      phoneNumber: populated,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/plivo/numbers
 * List all Plivo numbers owned by this user (from DB)
 */
router.get('/numbers', async (req, res, next) => {
  try {
    const numbers = await PhoneNumber.find({
      userId:   req.effectiveUserId,
      provider: 'plivo',
    }).populate('assignedAgent', 'name _id status');

    res.json({ success: true, count: numbers.length, numbers });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/plivo/test-credentials
 * Test if Plivo credentials are valid
 */
router.post('/test-credentials', async (req, res, next) => {
  try {
    const { plivoAuthId, plivoAuthToken } = req.body;
    const authId    = plivoAuthId    || req.user.settings?.plivoAuthId    || process.env.PLIVO_AUTH_ID;
    const authToken = plivoAuthToken || req.user.settings?.plivoAuthToken || process.env.PLIVO_AUTH_TOKEN;

    if (!authId || !authToken) {
      return res.status(400).json({ success: false, message: 'Plivo Auth ID and Auth Token required' });
    }

    const client  = new plivo.Client(authId, authToken);
    const account = await client.accounts.get();

    res.json({
      success: true,
      message: 'Plivo credentials are valid ✅',
      account: {
        name:    account.name,
        email:   account.email,
        balance: account.cash_credits,
        currency: account.billing_mode,
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Invalid Plivo credentials: ' + error.message,
    });
  }
});

/**
 * GET /api/plivo/available-numbers
 * Search available phone numbers to purchase
 * Query params: country (default US), type (local/tollfree/mobile), pattern, limit
 */
router.get('/available-numbers', async (req, res, next) => {
  try {
    const { country = 'US', type = 'local', pattern = '', limit = 20 } = req.query;
    const user = await User.findById(req.user._id);

    const numbers = await plivoService.searchNumbers(user, {
      countryIso: country,
      type,
      pattern,
      limit: parseInt(limit),
    });

    res.json({ success: true, count: numbers.length, numbers });
  } catch (error) {
    console.error('Number search error:', error.message);
    next(error);
  }
});

/**
 * GET /api/plivo/account-numbers
 * List all numbers currently on this Plivo account
 */
router.get('/account-numbers', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const numbers = await plivoService.listAccountNumbers(user);
    res.json({ success: true, count: numbers.length, numbers });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/plivo/buy-number
 * Purchase a Plivo phone number and save to DB
 * Body: { number, country, type }
 */
router.post('/buy-number', async (req, res, next) => {
  try {
    const { number, country = 'US', type = 'local' } = req.body;

    if (!number) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    const existing = await PhoneNumber.findOne({ number });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Phone number already exists in system' });
    }

    const user       = await User.findById(req.effectiveUserId);
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';

    // Purchase via Plivo
    const buyResult = await plivoService.buyNumber(user, number, backendUrl);

    // Save to DB
    const phoneRecord = await PhoneNumber.create({
      userId:      req.effectiveUserId,
      number,
      country:     country,
      countryCode: country,
      type,
      provider:    'plivo',
      providerSid: buyResult.appId,  // Store Plivo App ID
      status:      'active',
      capabilities: { voice: true, sms: false },
    });

    console.log(`✅ Plivo number purchased: ${number} (App: ${buyResult.appId})`);

    res.status(201).json({
      success: true,
      number: phoneRecord,
      plivoAppId: buyResult.appId,
    });
  } catch (error) {
    console.error('Buy number error:', error.message);
    next(error);
  }
});

/**
 * DELETE /api/plivo/release-number/:numberId
 * Release (unrent) a Plivo phone number
 */
router.delete('/release-number/:numberId', async (req, res, next) => {
  try {
    const phoneRecord = await PhoneNumber.findOne({
      _id:    req.params.numberId,
      userId: req.effectiveUserId,
      provider: 'plivo',
    });

    if (!phoneRecord) {
      return res.status(404).json({ success: false, message: 'Phone number not found' });
    }

    const user = await User.findById(req.effectiveUserId);
    await plivoService.releaseNumber(user, phoneRecord.number);
    await PhoneNumber.deleteOne({ _id: phoneRecord._id });

    console.log(`🗑️  Plivo number released: ${phoneRecord.number}`);

    res.json({ success: true, message: `Number ${phoneRecord.number} released successfully` });
  } catch (error) {
    console.error('Release number error:', error.message);
    next(error);
  }
});

/**
 * POST /api/plivo/make-call
 * Initiate an outbound call (manual trigger or campaign)
 * Body: { to, from, agentId, campaignId }
 */
router.post('/make-call', async (req, res, next) => {
  try {
    const { to, from, agentId, campaignId } = req.body;

    if (!to || !agentId) {
      return res.status(400).json({ success: false, message: 'to and agentId are required' });
    }

    const user  = await User.findById(req.effectiveUserId);
    const agent = await Agent.findOne({ _id: agentId, userId: req.effectiveUserId });

    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    // Determine from number
    const fromNumber = from
      || user?.settings?.plivoPhoneNumber
      || process.env.PLIVO_PHONE_NUMBER;

    if (!fromNumber) {
      return res.status(400).json({
        success: false,
        message: 'No Plivo phone number configured. Purchase a number first.',
      });
    }

    const baseUrl = process.env.BACKEND_URL || 'http://localhost:5000';
    const qs      = new URLSearchParams({
      agentId:    agent._id.toString(),
      userId:     req.effectiveUserId.toString(),
      campaignId: campaignId || '',
    }).toString();

    // Make the call
    const callResult = await plivoService.makeCall({
      user,
      from: fromNumber,
      to,
      answerUrl: `${baseUrl}/api/plivo/outbound-connect?${qs}`,
      statusUrl: `${baseUrl}/api/plivo/status`,
    });

    const callUuid = callResult.requestUuid || callResult.message;

    // Create call log
    const callLog = await CallLog.create({
      userId:     req.effectiveUserId,
      agentId:    agent._id,
      agentName:  agent.name,
      callSid:    callUuid,
      fromNumber,
      toNumber:   to,
      direction:  'outbound',
      status:     'ongoing',
      startTime:  new Date(),
      provider:   'plivo',
      campaign:   campaignId || undefined,
    });

    res.json({
      success:  true,
      callUuid,
      callLogId: callLog._id,
      message:  `Call initiated to ${to}`,
    });
  } catch (error) {
    console.error('Make call error:', error.message);
    next(error);
  }
});

/**
 * GET /api/plivo/call/:callUuid
 * Get live call status
 */
router.get('/call/:callUuid', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const call = await plivoService.getCallStatus(user, req.params.callUuid);
    res.json({ success: true, status: call.callState, duration: call.duration });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/plivo/call/:callUuid/hangup
 * Hang up an active call
 */
router.post('/call/:callUuid/hangup', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    await plivoService.hangupCall(user, req.params.callUuid);
    res.json({ success: true, message: 'Call terminated' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
