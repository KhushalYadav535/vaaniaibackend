/**
 * Post-Call Webhook Dispatcher
 * 
 * Sends a structured POST request to user's configured webhook URL
 * (n8n, Zapier, Make.com, or any custom backend) after every call ends.
 * 
 * Payload format:
 * {
 *   event: 'call.ended',
 *   callId, agentId, agentName, direction,
 *   duration, startTime, endTime,
 *   customer: { phone, name, email },
 *   transcript: [...],
 *   summary, sentiment, emotion, topics,
 *   extractedData: { name, email, phone, company },
 *   actionItems: [...],
 *   leadScore, followUpRequired,
 *   metrics: { qaScore, nps, csat },
 *   transferredTo,
 * }
 */

const axios = require('axios');
const crypto = require('crypto');

class WebhookDispatcher {
  /**
   * Fire the post-call webhook for a given user + call log
   * @param {Object} callLog - Mongoose CallLog document
   * @param {Object} agent   - Mongoose Agent document
   * @param {Object} userSettings - user.settings object
   */
  async dispatch(callLog, agent, userSettings = {}) {
    const webhookUrl = userSettings?.postCallWebhookUrl;

    if (!webhookUrl || webhookUrl.trim() === '') {
      return; // No webhook configured — skip silently
    }

    // ── Build the payload ────────────────────────────────────────────────────
    const payload = {
      event: 'call.ended',
      timestamp: new Date().toISOString(),

      // Call Metadata
      call: {
        id: callLog._id?.toString(),
        sessionId: callLog.sessionId,
        direction: callLog.direction || 'web',
        status: callLog.status,
        startTime: callLog.startTime,
        endTime: callLog.endTime || new Date(),
        durationSeconds: callLog.duration || 0,
        endReason: callLog.endReason || 'unknown',
      },

      // Agent Info
      agent: {
        id: agent?._id?.toString(),
        name: agent?.name || callLog.agentName,
        language: agent?.language || 'en',
      },

      // Customer Info (from extracted data or call params)
      customer: {
        phone: callLog.from || callLog.callParams?.from || null,
        name: callLog.extractedData?.name || null,
        email: callLog.extractedData?.email || null,
        company: callLog.extractedData?.company || null,
      },

      // Full Transcript (array of { role, content } objects)
      transcript: (callLog.transcript || []).map(t => ({
        role: t.role,
        message: t.content,
      })),

      // AI Analysis Results
      analysis: {
        summary: callLog.summary || null,
        sentiment: callLog.sentiment || 'neutral',
        emotion: callLog.emotion || 'neutral',
        topics: callLog.topics || [],
        decisions: callLog.decisions || [],
        customerIntent: callLog.customerIntent || null,
        urgencyLevel: callLog.urgencyLevel || 'low',
        followUpRequired: callLog.followUpRequired || false,
        actionItems: callLog.actionItems || [],
      },

      // Extracted Structured Data (ready for CRM)
      extractedData: callLog.extractedData || {},

      // Performance Metrics
      metrics: {
        qaScore: callLog.qa?.score || 0,
        nps: callLog.metrics?.nps || 0,
        csat: callLog.metrics?.csat || 0,
      },

      // Transfer Info
      transfer: callLog.transferredTo ? {
        transferredTo: callLog.transferredTo,
        reason: callLog.transferReason || null,
      } : null,

      // Sentiment Timeline
      sentimentTimeline: callLog.liveSentimentTimeline || [],
    };

    // ── Sign the payload (optional HMAC for verification) ───────────────────
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'VaaniAI-Webhook/1.0',
      'X-VaaniAI-Event': 'call.ended',
      'X-VaaniAI-Timestamp': payload.timestamp,
    };

    const secret = userSettings?.webhookSecret;
    if (secret && secret.trim() !== '') {
      const signature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex');
      headers['X-VaaniAI-Signature'] = `sha256=${signature}`;
    }

    // ── Fire and log ─────────────────────────────────────────────────────────
    try {
      console.log(`[Webhook] 🚀 Dispatching post-call event to: ${webhookUrl}`);
      const res = await axios.post(webhookUrl, payload, {
        headers,
        timeout: 10000, // 10s timeout — don't block
      });
      console.log(`[Webhook] ✅ Success (${res.status}) for call ${callLog._id}`);
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data || err.message;
      console.error(`[Webhook] ❌ Failed for call ${callLog._id} → Status: ${status}, Error: ${JSON.stringify(msg)}`);
    }
  }
}

module.exports = new WebhookDispatcher();
