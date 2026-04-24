/**
 * Twilio Telephony Routes - Enhanced
 * 
 * Handles real phone calls via Twilio:
 * - POST /api/twilio/inbound              → Inbound call webhook
 * - POST /api/twilio/outbound-connect     → Outbound call TwiML
 * - POST /api/twilio/status                → Call status updates
 * - POST /api/twilio/recording             → Recording completion webhook
 * - POST /api/twilio/gather-response      → Speech gathering responses
 * 
 * Setup:
 * 1. Create Twilio account at https://twilio.com
 * 2. Add TWILIO_* env variables
 * 3. Configure webhooks in Twilio console
 */

const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const Agent = require('../models/Agent');
const PhoneNumber = require('../models/PhoneNumber');
const CallLog = require('../models/CallLog');
const User = require('../models/User');
const Campaign = require('../models/Campaign');
const voicePipeline = require('../services/voicePipeline');
const toolExecutor = require('../services/toolExecutor');
const localStorageService = require('../services/localStorageService');
const campaignWorker = require('../services/campaignWorker');
const notificationService = require('../services/notificationService');
const { protect } = require('../middleware/auth');

// Helper: get Twilio client
function getTwilioClient(user) {
  const sid = user?.settings?.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID;
  const token = user?.settings?.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio credentials not configured');
  return twilio(sid, token);
}

// Helper: map voice IDs to Twilio voices
function mapVoiceToTwilio(voiceId = 'en-US-JennyNeural') {
  const voiceMap = {
    'en-US-JennyNeural': 'Polly.Joanna',
    'en-US-GuyNeural': 'Polly.Matthew',
    'en-US-AriaNeural': 'Polly.Kimberly',
    'en-GB-SoniaNeural': 'Polly.Amy',
    'en-AU-NatashaNeural': 'Polly.Russell',
  };
  return voiceMap[voiceId] || 'Polly.Joanna';
}

/**
 * INBOUND CALL WEBHOOK
 * Twilio calls this URL when someone dials your number
 * Set this as the "Voice Webhook URL" in your Twilio console
 * POST /api/twilio/inbound
 */
router.post('/inbound', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const { To, From, CallSid } = req.body;

    console.log(`📞 Inbound call: ${From} → ${To} (SID: ${CallSid})`);

    // Find the phone number
    const phoneRecord = await PhoneNumber.findOne({ number: To }).populate('assignedAgent');
    
    if (!phoneRecord || !phoneRecord.assignedAgent) {
      console.warn(`⚠️ No agent assigned to ${To}`);
      twiml.say(
        { voice: 'Polly.Joanna' },
        'Sorry, this number is not configured with an AI agent. Please try again later.'
      );
      return res.type('text/xml').send(twiml.toString());
    }

    const agent = phoneRecord.assignedAgent;
    const user = await User.findById(agent.userId);

    // Create call log
    const callLog = await CallLog.create({
      userId: agent.userId,
      agentId: agent._id,
      agentName: agent.name,
      callSid: CallSid,
      fromNumber: From,
      toNumber: To,
      direction: 'inbound',
      status: 'answered',
      startTime: new Date(),
      transcript: [],
    });

    // First message
    const firstMessage = agent.firstMessage || 'Hello! How can I help you today?';

    // Create gather for speech input
    const gather = twiml.gather({
      input: 'speech',
      speechTimeout: 'auto',
      language: 'en-US',
      action: `/api/twilio/gather-response?callSid=${CallSid}&agentId=${agent._id}`,
      method: 'POST',
      hints: 'yes, no, okay, sure, thank you, goodbye',
    });

    gather.say(
      { voice: mapVoiceToTwilio(agent.voice?.voiceId) },
      firstMessage
    );

    // If no response
    twiml.say(
      { voice: mapVoiceToTwilio(agent.voice?.voiceId) },
      'I did not hear anything. Goodbye!'
    );
    twiml.hangup();

    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('❌ Inbound webhook error:', error);
    twiml.say('Sorry, an error occurred. Please try again later.');
    res.type('text/xml').send(twiml.toString());
  }
});

/**
 * POST /api/twilio/gather-response
 * Called after Twilio gathers speech
 */
router.post('/gather-response', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const { callSid, agentId } = req.query;
    const { SpeechResult, Confidence } = req.body;

    console.log(`🎙️ User said: "${SpeechResult}" (confidence: ${Confidence})`);

    const callLog = await CallLog.findOne({ callSid });
    const agent = await Agent.findById(agentId);

    if (!callLog || !agent) {
      twiml.say('Session not found. Goodbye!');
      twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }

    // Low confidence check
    if (parseFloat(Confidence) < 0.5) {
      const gather = twiml.gather({
        input: 'speech',
        speechTimeout: 'auto',
        language: 'en-US',
        action: `/api/twilio/gather-response?callSid=${callSid}&agentId=${agentId}`,
        method: 'POST',
      });

      gather.say(
        { voice: mapVoiceToTwilio(agent.voice?.voiceId) },
        'Sorry, I did not understand that clearly. Could you please repeat?'
      );
      return res.type('text/xml').send(twiml.toString());
    }

    // Check for end call phrases
    const endPhrases = agent.endCallPhrases || ['bye', 'goodbye', 'thanks', 'thank you', 'done'];
    const shouldEnd = endPhrases.some(phrase =>
      SpeechResult.toLowerCase().includes(phrase.toLowerCase())
    );

    // Save user message
    callLog.transcript.push({
      role: 'user',
      content: SpeechResult,
      timestamp: new Date(),
      confidence: Confidence,
    });
    await callLog.save();

    if (shouldEnd) {
      const endMsg = agent.endCallMessage || 'Thank you for calling. Goodbye!';
      twiml.say(
        { voice: mapVoiceToTwilio(agent.voice?.voiceId) },
        endMsg
      );
      twiml.hangup();
      
      // Update call log
      callLog.status = 'completed';
      callLog.endTime = new Date();
      await callLog.save();

      return res.type('text/xml').send(twiml.toString());
    }

    // Get user settings
    const user = await User.findById(agent.userId);

    // Process through voice pipeline
    const result = await voicePipeline.processText({
      text: SpeechResult,
      agent,
      history: callLog.transcript.slice(-10),
      userSettings: user?.settings || {},
    });

    // Handle tool calls if any
    if (result.toolCalls && result.toolCalls.length > 0) {
      const toolResults = await toolExecutor.executeToolCalls({
        toolCalls: result.toolCalls,
        agentContext: {
          callSid,
          agentId,
          userId: agent.userId,
          fromNumber: callLog.fromNumber,
        },
      });
      console.log('🔧 Tool execution results:', toolResults);
    }

    // Save AI response
    callLog.transcript.push({
      role: 'assistant',
      content: result.response,
      timestamp: new Date(),
    });
    await callLog.save();

    // Continue conversation
    const gather = twiml.gather({
      input: 'speech',
      speechTimeout: 'auto',
      language: 'en-US',
      action: `/api/twilio/gather-response?callSid=${callSid}&agentId=${agentId}`,
      method: 'POST',
      timeout: 10,
    });

    gather.say(
      { voice: mapVoiceToTwilio(agent.voice?.voiceId) },
      result.response
    );

    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('❌ Gather response error:', error);
    twiml.say('Sorry, an error occurred. Goodbye!');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

/**
 * OUTBOUND CALL CONNECT TwiML
 * Called by Twilio when outbound call connects
 */
router.post('/outbound-connect', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    const { agentId, userId, campaignId } = req.query;
    const { CallSid } = req.body;

    const agent = await Agent.findById(agentId);
    const user = await User.findById(userId);

    if (!agent) {
      twiml.say('Agent not found. Goodbye!');
      twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }

    // Create call log for outbound
    const callLog = await CallLog.create({
      userId,
      agentId,
      agentName: agent.name,
      callSid: CallSid,
      direction: 'outbound',
      status: 'answered',
      campaign: campaignId || undefined,
      startTime: new Date(),
      transcript: [],
    });

    const firstMessage = agent.firstMessage || 'Hello! How can I help you today?';

    const gather = twiml.gather({
      input: 'speech',
      speechTimeout: 'auto',
      language: 'en-US',
      action: `/api/twilio/gather-response?callSid=${CallSid}&agentId=${agentId}&campaignId=${campaignId || ''}`,
      method: 'POST',
      timeout: 15,
    });

    gather.say(
      { voice: mapVoiceToTwilio(agent.voice?.voiceId) },
      firstMessage
    );

    twiml.hangup();

    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('❌ Outbound connect error:', error);
    twiml.say('Error connecting. Goodbye!');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

/**
 * POST /api/twilio/outbound
 * Make an outbound call (authenticated)
 */
router.post('/outbound', protect, async (req, res, next) => {
  try {
    const { to, agentId } = req.body;

    if (!to || !agentId) {
      return res.status(400).json({
        success: false,
        message: 'to (phone) and agentId required',
      });
    }

    const agent = await Agent.findOne({ _id: agentId, userId: req.user._id });
    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const user = await User.findById(req.user._id);
    const client = getTwilioClient(user);
    const fromNumber = user.settings?.twilioPhoneNumber || process.env.TWILIO_PHONE_NUMBER;

    if (!fromNumber) {
      return res.status(400).json({
        success: false,
        message: 'No Twilio number configured in Settings',
      });
    }

    const call = await client.calls.create({
      to,
      from: fromNumber,
      url: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/outbound-connect?agentId=${agent._id}&userId=${req.user._id}`,
      statusCallback: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: process.env.RECORD_CALLS === 'true',
      recordingStatusCallback: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/recording`,
    });

    // Log call
    await CallLog.create({
      userId: req.user._id,
      agentId: agent._id,
      agentName: agent.name,
      callSid: call.sid,
      fromNumber,
      toNumber: to,
      direction: 'outbound',
      status: 'initiated',
      startTime: new Date(),
    });

    res.json({
      success: true,
      callSid: call.sid,
      status: call.status,
      message: `Calling ${to}...`,
    });

  } catch (error) {
    next(error);
  }
});

/**
 * CALL STATUS WEBHOOK
 * Call status change webhook from Twilio
 */
router.post('/status', async (req, res) => {
  try {
    const {
      CallSid,
      CallStatus,
      CallDuration,
      RecordingUrl,
      RecordingSid,
      AnsweredBy,
      MachineDetectionResult,
    } = req.body;

    console.log(`📊 Call status update: ${CallSid} → ${CallStatus} (AnsweredBy: ${AnsweredBy || 'N/A'})`);

    const statusMap = {
      'completed': 'completed',
      'busy': 'no-answer',
      'no-answer': 'no-answer',
      'failed': 'failed',
      'canceled': 'failed',
      'ringing': 'ringing',
      'answered': 'answered',
    };

    // Map Twilio AnsweredBy values to our simplified enum
    let answeredByValue = '';
    if (AnsweredBy) {
      const amdMap = {
        'human': 'human',
        'machine_start': 'machine',
        'machine_end_beep': 'machine',
        'machine_end_silence': 'machine',
        'machine_end_other': 'machine',
        'fax': 'fax',
        'unknown': 'unknown',
      };
      answeredByValue = amdMap[AnsweredBy] || 'unknown';
    }

    const updateData = {
      status: statusMap[CallStatus] || CallStatus,
      endTime: new Date(),
      duration: parseInt(CallDuration) || 0,
      answeredBy: answeredByValue,
      metadata: {
        answeredBy: AnsweredBy || 'unknown',
        machineDetectionResult: MachineDetectionResult,
        recordingSid: RecordingSid,
        recordingUrl: RecordingUrl,
      },
    };

    // If voicemail detected, update status
    if (answeredByValue === 'machine') {
      updateData.endReason = 'voicemail';
      console.log(`🤖 Voicemail/Machine detected for ${CallSid}`);
    }

    const callLog = await CallLog.findOneAndUpdate(
      { callSid: CallSid },
      updateData,
      { new: true }
    );

    if (callLog && RecordingUrl) {
      console.log(`📁 Recording available: ${RecordingUrl}`);
      callLog.recordingUrl = RecordingUrl;
      await callLog.save();
    }

    // Update campaign if it's a campaign call
    if (callLog?.campaign) {
      await campaignWorker.handleCallCompletion({
        callSid: CallSid,
        status: answeredByValue === 'machine' ? 'voicemail' : (statusMap[CallStatus] || CallStatus),
        duration: parseInt(CallDuration) || 0,
        recordingUrl: RecordingUrl,
      });

      // Update campaign number status for voicemail
      if (answeredByValue === 'machine') {
        const campaign = await Campaign.findById(callLog.campaign);
        if (campaign) {
          const numRecord = campaign.numbers.find(n => n.callSid === CallSid);
          if (numRecord) {
            numRecord.status = 'voicemail';
            await campaign.save();
          }
        }
      }
    }

    // 📱 POST-CALL NOTIFICATIONS for phone calls (on completion)
    if (CallStatus === 'completed' && callLog) {
      // Run post-call analysis first
      if (callLog.transcript && callLog.transcript.length > 0) {
        voicePipeline.analyzeCall(callLog.transcript).then(async (analysis) => {
          if (analysis) {
            const updatedLog = await CallLog.findByIdAndUpdate(callLog._id, {
              summary: analysis.summary,
              sentiment: analysis.sentiment,
              emotion: analysis.emotion,
              metrics: analysis.metrics,
              actionItems: analysis.actionItems,
              extractedData: analysis.extractedData,
              topics: analysis.topics || [],
              decisions: analysis.decisions || [],
              customerIntent: analysis.customerIntent || '',
              urgencyLevel: analysis.urgencyLevel || '',
              followUpRequired: analysis.followUpRequired || false,
              qa: { score: analysis.qaScore || 0 },
            }, { new: true });

            // Send notifications after analysis
            const agent = await Agent.findById(callLog.agentId);
            if (agent?.postCallActions?.sendSMS || agent?.postCallActions?.sendWhatsApp) {
              const user = await User.findById(callLog.userId);
              notificationService.sendPostCallNotifications({
                callLog: updatedLog,
                agent,
                userSettings: user?.settings || {},
              }).catch(err => console.error('Notification error:', err.message));
            }

            console.log(`[✅ Post-Call] Analysis + Notifications for ${CallSid}`);
          }
        }).catch(err => console.error('Post-call analysis error:', err.message));
      }
    }

    res.sendStatus(204);

  } catch (error) {
    console.error('❌ Status webhook error:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /api/twilio/amd-callback
 * Async Answering Machine Detection callback
 * Called by Twilio when asyncAmd='true' in campaign calls
 */
router.post('/amd-callback', async (req, res) => {
  try {
    const { CallSid, AnsweredBy, MachineDetectionDuration } = req.body;
    console.log(`🤖 AMD Result: ${CallSid} → ${AnsweredBy} (${MachineDetectionDuration}ms)`);

    const callLog = await CallLog.findOne({ callSid: CallSid });
    if (!callLog) {
      return res.sendStatus(204);
    }

    // Update answeredBy
    const isVoicemail = ['machine_start', 'machine_end_beep', 'machine_end_silence', 'machine_end_other'].includes(AnsweredBy);
    callLog.answeredBy = isVoicemail ? 'machine' : (AnsweredBy === 'human' ? 'human' : 'unknown');

    if (isVoicemail) {
      callLog.endReason = 'voicemail';
      console.log(`📩 Voicemail detected for ${CallSid} — will leave message if configured`);

      // If agent has a voicemail message, we could use Twilio to modify the call
      // For now, just log it. The TwiML can be updated to check AMD in outbound-connect
      const agent = await Agent.findById(callLog.agentId);
      if (agent?.voicemailMessage) {
        try {
          const user = await User.findById(callLog.userId);
          const client = getTwilioClient(user);

          // Update the live call to play voicemail message instead
          await client.calls(CallSid).update({
            twiml: `<Response><Say voice="${mapVoiceToTwilio(agent.voice?.voiceId)}">${agent.voicemailMessage}</Say><Hangup/></Response>`,
          });

          console.log(`📤 Voicemail message sent for ${CallSid}`);
        } catch (twimlError) {
          console.error('Failed to update call with voicemail:', twimlError.message);
        }
      }
    }

    await callLog.save();
    res.sendStatus(204);

  } catch (error) {
    console.error('❌ AMD callback error:', error);
    res.sendStatus(500);
  }
});

/**
 * POST /api/twilio/recording
 * Recording completion webhook
 */
router.post('/recording', async (req, res) => {
  try {
    const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = req.body;

    console.log(`🎙️ Recording complete: ${RecordingSid}`);

    const callLog = await CallLog.findOne({ callSid: CallSid });

    if (!callLog) {
      console.warn(`⚠️ Call log not found: ${CallSid}`);
      return res.sendStatus(404);
    }

    // Update recording info
    callLog.recordingUrl = RecordingUrl;
    callLog.recordingSid = RecordingSid;
    callLog.recordingDuration = parseInt(RecordingDuration) || 0;
    await callLog.save();

    // Download and save to local storage
    if (RecordingUrl) {
      try {
        const fetch = require('node-fetch');
        const recordingResponse = await fetch(RecordingUrl);
        const recordingBuffer = await recordingResponse.buffer();

        const localResult = await localStorageService.saveRecording({
          recordingBuffer,
          callSid: CallSid,
          userId: callLog.userId,
          agentId: callLog.agentId,
        });

        console.log(`💾 Recording saved locally: ${localResult.relativePath}`);
        callLog.localRecordingPath = localResult.relativePath;
        callLog.recordingUrl = localResult.url;
        await callLog.save();
      } catch (storageError) {
        console.warn(`⚠️ Local storage save failed: ${storageError.message}`);
        // Don't fail the webhook even if storage fails
      }
    }

    res.sendStatus(204);

  } catch (error) {
    console.error('❌ Recording webhook error:', error);
    res.sendStatus(500);
  }
});

/**
 * GET /api/twilio/call/:callSid
 * Check live status of an ongoing call
 */
router.get('/call/:callSid', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const client = getTwilioClient(user);
    const call = await client.calls(req.params.callSid).fetch();
    res.json({ success: true, status: call.status, duration: call.duration });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/twilio/transfer
 * Transfer an active call to a human agent (warm transfer)
 * Body: { callSid, transferTo, reason, context }
 */
router.post('/transfer', protect, async (req, res, next) => {
  try {
    const { callSid, transferTo, reason, context } = req.body;
    
    if (!callSid || !transferTo) {
      return res.status(400).json({ success: false, message: 'callSid and transferTo are required' });
    }

    const user = await User.findById(req.user._id);
    const client = getTwilioClient(user);

    // Build TwiML for warm transfer with whisper
    const whisperMsg = context 
      ? `Incoming transfer from AI agent. ${context.substring(0, 200)}`
      : 'Incoming transfer from AI agent.';

    const twiml = `<Response>
      <Say voice="alice">Please hold while I connect you with a team member.</Say>
      <Dial callerId="${user?.settings?.twilioPhoneNumber || process.env.TWILIO_PHONE_NUMBER}">
        <Number url="${process.env.BACKEND_URL || 'http://localhost:5000'}/api/twilio/transfer-whisper?context=${encodeURIComponent(whisperMsg)}">${transferTo}</Number>
      </Dial>
      <Say voice="alice">We were unable to connect you. Please try again later. Goodbye.</Say>
    </Response>`;

    // Update the live call with transfer TwiML
    await client.calls(callSid).update({ twiml });

    // Update call log
    await CallLog.findOneAndUpdate(
      { callSid },
      {
        transferredTo: transferTo,
        transferReason: reason || 'manual_transfer',
        endReason: 'transferred',
      }
    );

    console.log(`[🔄 Transfer] ${callSid} → ${transferTo} (${reason})`);
    res.json({ success: true, message: 'Call transferred', transferTo });

  } catch (error) {
    console.error('Transfer error:', error);
    next(error);
  }
});

/**
 * POST /api/twilio/transfer-whisper
 * Whisper endpoint — plays context message to the human agent before connecting
 */
router.post('/transfer-whisper', (req, res) => {
  const context = req.query.context || 'Incoming transfer from AI agent.';
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  response.say({ voice: 'alice' }, context);
  res.type('text/xml');
  res.send(response.toString());
});

/**
 * POST /api/twilio/whatsapp
 * Webhook for incoming WhatsApp messages
 */
router.post('/whatsapp', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const { From, To, Body, ProfileName } = req.body;
    console.log(`💬 WhatsApp message from ${From} to ${To}: "${Body}"`);

    // In a real scenario, you'd look up the Agent assigned to the Twilio number 'To'
    // For this demo, let's just pick the first active agent
    const agent = await Agent.findOne({ status: 'active' });
    if (!agent) {
      twiml.message('Sorry, no agent is currently available to respond.');
      return res.type('text/xml').send(twiml.toString());
    }

    // Maintain conversation history in MongoDB (or UserMemory)
    // Find or create a CallLog but repurpose it for chat
    let chatLog = await CallLog.findOne({
      fromNumber: From,
      agentId: agent._id,
      direction: 'inbound',
      status: 'ongoing',
    }).sort({ createdAt: -1 });

    if (!chatLog) {
      chatLog = await CallLog.create({
        userId: agent.userId,
        agentId: agent._id,
        agentName: agent.name,
        fromNumber: From,
        toNumber: To,
        direction: 'inbound',
        status: 'ongoing',
        startTime: new Date(),
        transcript: [],
      });
    }

    chatLog.transcript.push({
      role: 'user',
      content: Body,
      timestamp: new Date(),
    });

    const user = await User.findById(agent.userId);

    // Use voicePipeline.processText to get the response
    const result = await voicePipeline.processText({
      text: Body,
      agent,
      history: chatLog.transcript.slice(-10),
      userSettings: user?.settings || {},
    });

    // Execute tools if any
    if (result.toolCalls && result.toolCalls.length > 0) {
      const toolResults = await toolExecutor.executeToolCalls({
        toolCalls: result.toolCalls,
        agentContext: {
          agentId: agent._id,
          userId: agent.userId,
          fromNumber: From,
        },
      });
      console.log('🔧 WhatsApp Tool execution results:', toolResults);
    }

    chatLog.transcript.push({
      role: 'assistant',
      content: result.response,
      timestamp: new Date(),
    });
    
    // Auto-close chat after 10 mins of inactivity, but for now just save
    await chatLog.save();

    // Reply via Twilio WhatsApp
    twiml.message(result.response);
    res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('❌ WhatsApp webhook error:', error);
    twiml.message('Sorry, I am experiencing technical difficulties.');
    res.type('text/xml').send(twiml.toString());
  }
});

module.exports = router;
