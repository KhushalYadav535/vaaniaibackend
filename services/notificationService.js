/**
 * Notification Service
 * Handles post-call SMS and WhatsApp follow-ups via Twilio
 * 
 * Twilio already installed as dependency — zero cost for WhatsApp sandbox
 * Production WhatsApp requires Twilio + Meta Business API approval
 */
const twilio = require('twilio');
const CallLog = require('../models/CallLog');

class NotificationService {
  /**
   * Get Twilio client for the user
   */
  getTwilioClient(userSettings) {
    const sid = userSettings?.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID;
    const token = userSettings?.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new Error('Twilio credentials not configured');
    }
    return twilio(sid, token);
  }

  /**
   * Send post-call notifications based on agent configuration
   * Called after call analysis is complete
   */
  async sendPostCallNotifications({ callLog, agent, userSettings }) {
    const actions = agent.postCallActions;
    if (!actions) return;

    const toNumber = callLog.fromNumber || callLog.toNumber;
    if (!toNumber) {
      console.warn('⚠️ No phone number to send notification to');
      return;
    }

    const notifications = [];

    // Build template variables
    const templateVars = this.buildTemplateVars(callLog, agent);

    // Send SMS if enabled
    if (actions.sendSMS) {
      try {
        const result = await this.sendSMS({
          to: toNumber,
          message: this.replaceTemplateVars(actions.smsTemplate, templateVars),
          userSettings,
        });
        notifications.push({
          channel: 'sms',
          to: toNumber,
          sentAt: new Date(),
          status: 'sent',
          messageSid: result.sid,
        });
        console.log(`✅ Post-call SMS sent to ${toNumber}`);
      } catch (error) {
        console.error(`❌ SMS failed to ${toNumber}:`, error.message);
        notifications.push({
          channel: 'sms',
          to: toNumber,
          sentAt: new Date(),
          status: 'failed',
        });
      }
    }

    // Send WhatsApp if enabled
    if (actions.sendWhatsApp) {
      try {
        const result = await this.sendWhatsApp({
          to: toNumber,
          message: this.replaceTemplateVars(actions.whatsappTemplate, templateVars),
          userSettings,
        });
        notifications.push({
          channel: 'whatsapp',
          to: toNumber,
          sentAt: new Date(),
          status: 'sent',
          messageSid: result.sid,
        });
        console.log(`✅ Post-call WhatsApp sent to ${toNumber}`);
      } catch (error) {
        console.error(`❌ WhatsApp failed to ${toNumber}:`, error.message);
        notifications.push({
          channel: 'whatsapp',
          to: toNumber,
          sentAt: new Date(),
          status: 'failed',
        });
      }
    }

    // Save notification records to call log
    if (notifications.length > 0 && callLog._id) {
      try {
        await CallLog.findByIdAndUpdate(callLog._id, {
          $push: { notificationsSent: { $each: notifications } },
        });
      } catch (e) {
        console.error('Failed to save notification records:', e.message);
      }
    }

    return notifications;
  }

  /**
   * Send SMS via Twilio
   */
  async sendSMS({ to, message, userSettings }) {
    const client = this.getTwilioClient(userSettings);
    const from = userSettings?.twilioPhoneNumber || process.env.TWILIO_PHONE_NUMBER;

    if (!from) throw new Error('No Twilio phone number configured for SMS');

    const result = await client.messages.create({
      body: message,
      from,
      to,
    });

    return result;
  }

  /**
   * Send WhatsApp message via Twilio
   * Sandbox: Use 'whatsapp:+14155238886' (Twilio sandbox number)
   * Production: Use your approved Twilio WhatsApp number
   */
  async sendWhatsApp({ to, message, userSettings }) {
    const client = this.getTwilioClient(userSettings);
    const from = userSettings?.twilioWhatsAppNumber
      || process.env.TWILIO_WHATSAPP_NUMBER
      || 'whatsapp:+14155238886'; // Twilio sandbox default

    // Ensure WhatsApp format
    const whatsappTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
    const whatsappFrom = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;

    const result = await client.messages.create({
      body: message,
      from: whatsappFrom,
      to: whatsappTo,
    });

    return result;
  }

  /**
   * Build template variables from call data
   */
  buildTemplateVars(callLog, agent) {
    const durationMins = Math.round((callLog.duration || 0) / 60);
    const durationStr = durationMins > 0 ? `${durationMins} min` : `${callLog.duration || 0} sec`;

    return {
      agentName: agent.name || callLog.agentName || 'AI Agent',
      summary: callLog.summary || 'No summary available',
      duration: durationStr,
      sentiment: callLog.sentiment || 'neutral',
      actionItems: (callLog.actionItems || []).length > 0
        ? callLog.actionItems.map((item, i) => `${i + 1}. ${item}`).join('\n')
        : 'No action items',
      customerName: callLog.extractedData?.get?.('name') || callLog.extractedData?.name || '',
      date: new Date().toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }),
      callId: callLog._id?.toString()?.slice(-6) || '',
    };
  }

  /**
   * Replace {{variable}} placeholders in template
   */
  replaceTemplateVars(template, vars) {
    if (!template) return '';

    let result = template;
    Object.entries(vars).forEach(([key, value]) => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      result = result.replace(regex, value || '');
    });

    return result;
  }
}

module.exports = new NotificationService();
