/**
 * Tool Executor Service
 * Handles function calling for LLM agents during live calls.
 *
 * Resolution order for any tool call:
 *   1. If the agent defines this tool with a custom `serverUrl`, POST to it
 *      (true "bring your own backend" — Vapi/Retell style).
 *   2. Else if it's a built-in tool, run the built-in handler. CRM-related
 *      built-ins (create_ticket, book_appointment, capture_lead, etc.) persist
 *      to the user's real Lead/Ticket collections, scoped by agent.userId.
 *   3. Else return a clear "not connected" result so the LLM can recover
 *      gracefully instead of hallucinating success.
 */
const Lead = require('../models/Lead');
const Ticket = require('../models/Ticket');

// Map loose/templated priority strings onto the Ticket enum (High/Medium/Low).
function normalizePriority(p) {
  const v = String(p || '').toLowerCase();
  if (v.startsWith('h') || v === 'urgent') return 'High';
  if (v.startsWith('l')) return 'Low';
  return 'Medium';
}

// Pull a userId out of whatever agent context we were handed.
function resolveUserId(agentContext) {
  const uid = agentContext?.userId;
  if (!uid) return null;
  return uid._id ? uid._id : uid; // handles populated or raw ObjectId
}

class ToolExecutor {
  constructor() {
    // Registry of built-in tools. Names cover both the generic set and the
    // names used by the shipped agent templates so nothing falls through to
    // "tool not found" during a call.
    this.tools = {
      // CRM-backed (persist real data)
      'create_ticket': this.createTicket.bind(this),
      'escalate_to_human': this.escalateToHuman.bind(this),
      'book_appointment': this.bookAppointment.bind(this),
      'schedule_visit': this.scheduleVisit.bind(this),
      'capture_lead': this.captureLead.bind(this),
      'update_customer_info': this.updateCustomerInfo.bind(this),

      // Lookup / action helpers (best-effort; prefer a custom serverUrl)
      'get_customer_info': this.getCustomerInfo.bind(this),
      'get_availability': this.getAvailability.bind(this),
      'check_availability': this.getAvailability.bind(this),
      'search_properties': this.searchProperties.bind(this),
      'track_order': this.trackOrder.bind(this),
      'process_return': this.processReturn.bind(this),
      'update_delivery_status': this.updateDeliveryStatus.bind(this),
      'contact_driver': this.contactDriver.bind(this),

      // Comms / misc
      'send_email': this.sendEmail.bind(this),
      'send_sms': this.sendSMS.bind(this),
      'schedule_call': this.scheduleCall.bind(this),
      'log_call_note': this.logCallNote.bind(this),
      'transfer_to_agent': this.transferToAgent.bind(this),
    };
  }

  /**
   * Execute a single tool call from the LLM.
   * @param {object} p
   * @param {string} p.toolName
   * @param {object} p.toolInput
   * @param {object} p.agentContext  the agent doc (carries userId, _id, tools)
   * @param {object} [p.callContext] optional { callLogId, callerPhone }
   */
  async executeTool({ toolName, toolInput, agentContext, callContext = {} }) {
    try {
      // 1. Custom webhook tool takes precedence — the user wired their own backend.
      const customTool = agentContext?.tools?.find(t => t.function?.name === toolName);
      if (customTool && customTool.serverUrl) {
        console.log(`🔧 Custom webhook tool: ${toolName} → ${customTool.serverUrl}`);
        const axios = require('axios');
        const response = await axios.post(customTool.serverUrl, toolInput, {
          timeout: 8000,
          headers: {
            'Content-Type': 'application/json',
            'X-VaaniAI-Agent-Id': agentContext?._id?.toString() || 'unknown',
          },
        });
        return { success: true, tool: toolName, result: response.data, timestamp: new Date().toISOString() };
      }

      // 2. Built-in tool.
      if (this.tools[toolName]) {
        console.log(`🔧 Executing built-in tool: ${toolName}`, toolInput);
        const result = await this.tools[toolName](toolInput || {}, agentContext, callContext);
        return { success: true, tool: toolName, result, timestamp: new Date().toISOString() };
      }

      // 3. Unknown tool — honest failure so the LLM doesn't fake success.
      return {
        success: false,
        tool: toolName,
        result: { status: 'not_connected', message: `No handler or serverUrl configured for "${toolName}".` },
      };
    } catch (error) {
      console.error(`❌ Tool execution failed (${toolName}):`, error.message);
      return { success: false, tool: toolName, error: error.message };
    }
  }

  async executeToolCalls({ toolCalls, agentContext, callContext = {} }) {
    const results = [];
    for (const toolCall of toolCalls) {
      const result = await this.executeTool({
        toolName: toolCall.function?.name,
        toolInput: toolCall.function?.arguments || {},
        agentContext,
        callContext,
      });
      results.push(result);
    }
    return results;
  }

  // ─── CRM-BACKED TOOLS ───────────────────────────────────────────────────

  async createTicket(input, agentContext, callContext = {}) {
    const userId = resolveUserId(agentContext);
    const name = input.name || input.customerName || input.patientName || 'Unknown Caller';
    const phone = input.phone || callContext.callerPhone || '';
    const issue = input.issue || input.description || input.title || 'Issue reported during call';

    if (!userId) {
      return { status: 'error', message: 'Cannot create ticket: missing user context.' };
    }

    const ticket = await Ticket.create({
      userId,
      agentId: agentContext?._id,
      callLogId: callContext.callLogId,
      name,
      phone,
      email: input.email || '',
      issue,
      priority: normalizePriority(input.priority),
      status: 'Open',
    });

    return {
      status: 'created',
      ticketId: ticket._id.toString(),
      priority: ticket.priority,
      message: `Support ticket created for ${name}.`,
    };
  }

  async escalateToHuman(input, agentContext, callContext = {}) {
    const userId = resolveUserId(agentContext);
    // Mark the related ticket as escalated when we can find one.
    if (userId && input.ticketId) {
      await Ticket.findOneAndUpdate(
        { _id: input.ticketId, userId },
        { $set: { priority: 'High', status: 'In Progress', resolution: `Escalated: ${input.reason || 'caller request'}` } }
      ).catch(() => {});
    }
    return {
      status: 'escalation_requested',
      ticketId: input.ticketId || null,
      reason: input.reason || 'caller request',
      message: 'Escalation logged. A human agent will follow up.',
    };
  }

  /**
   * Used by sales + clinic templates. Captures the caller as a Lead and
   * returns a confirmation id. (We store appointments as leads with notes,
   * since there is no separate Appointment model.)
   */
  async bookAppointment(input, agentContext, callContext = {}) {
    const userId = resolveUserId(agentContext);
    const name = input.name || input.patientName || input.customerName || 'Unknown Caller';
    const phone = input.phone || callContext.callerPhone || '';
    const when = input.datetime || input.time || input.date || '';

    if (!userId) {
      return { status: 'error', message: 'Cannot book: missing user context.' };
    }

    const noteParts = [
      when ? `Appointment: ${when}` : '',
      input.doctor ? `Doctor: ${input.doctor}` : '',
      input.appointmentType ? `Type: ${input.appointmentType}` : '',
      input.service_type ? `Service: ${input.service_type}` : '',
      input.insurance ? `Insurance: ${input.insurance}` : '',
    ].filter(Boolean).join(' | ');

    await this._upsertLead({
      userId,
      agentId: agentContext?._id,
      callLogId: callContext.callLogId,
      name,
      phone,
      email: input.email || '',
      interest: input.budget ? `Budget: ${input.budget}` : (input.company || ''),
      status: 'Hot',
      notes: noteParts,
    });

    return {
      status: 'confirmed',
      appointmentId: `APT-${Date.now()}`,
      when,
      message: `Appointment booked for ${name}${when ? ` on ${when}` : ''}.`,
    };
  }

  /** Real-estate site visit → lead capture. */
  async scheduleVisit(input, agentContext, callContext = {}) {
    const userId = resolveUserId(agentContext);
    const name = input.name || 'Unknown Caller';
    const phone = input.phone || callContext.callerPhone || '';
    if (!userId) return { status: 'error', message: 'Cannot schedule: missing user context.' };

    await this._upsertLead({
      userId,
      agentId: agentContext?._id,
      callLogId: callContext.callLogId,
      name,
      phone,
      email: input.email || '',
      interest: input.propertyId ? `Property: ${input.propertyId}` : 'Property viewing',
      status: 'Hot',
      notes: input.datetime ? `Site visit: ${input.datetime}` : '',
    });

    return {
      status: 'scheduled',
      visitId: `VISIT-${Date.now()}`,
      message: `Site visit scheduled for ${name}.`,
    };
  }

  /** Generic lead capture used by sales-style agents. */
  async captureLead(input, agentContext, callContext = {}) {
    const userId = resolveUserId(agentContext);
    const name = input.name || 'Unknown Caller';
    const phone = input.phone || callContext.callerPhone || '';
    if (!userId) return { status: 'error', message: 'Cannot capture lead: missing user context.' };

    const lead = await this._upsertLead({
      userId,
      agentId: agentContext?._id,
      callLogId: callContext.callLogId,
      name,
      phone,
      email: input.email || '',
      interest: input.interest || input.product || input.company || '',
      status: input.status || 'Warm',
      value: input.budget || input.value || '',
      notes: input.notes || '',
    });

    return { status: 'captured', leadId: lead?._id?.toString(), message: `Lead captured for ${name}.` };
  }

  async updateCustomerInfo(input, agentContext) {
    const userId = resolveUserId(agentContext);
    const phone = input.phone || input.customerId;
    if (!userId || !phone) {
      return { status: 'error', message: 'Need a phone number to update a customer record.' };
    }
    const updates = input.updates || input;
    const set = {};
    if (updates.email) set.email = updates.email;
    if (updates.name) set.name = updates.name;
    if (updates.notes) set.notes = updates.notes;
    if (updates.status) set.status = updates.status;

    const lead = await Lead.findOneAndUpdate({ userId, phone }, { $set: set }, { new: true });
    return lead
      ? { status: 'updated', leadId: lead._id.toString(), updatedFields: Object.keys(set) }
      : { status: 'not_found', message: 'No matching customer record.' };
  }

  async getCustomerInfo(input, agentContext) {
    const userId = resolveUserId(agentContext);
    const phone = input.phone || input.customerId;
    if (!userId || !phone) return { status: 'not_found', message: 'No phone provided.' };
    const lead = await Lead.findOne({ userId, phone }).lean();
    if (!lead) return { status: 'not_found', message: 'No record found for this caller.' };
    return {
      status: 'found',
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      leadStatus: lead.status,
      notes: lead.notes,
    };
  }

  // Shared upsert: avoid duplicate leads for the same (userId, phone).
  async _upsertLead({ userId, agentId, callLogId, name, phone, email, interest, status, value, notes }) {
    if (!phone) {
      return Lead.create({ userId, agentId, callLogId, name, phone, email, interest, status, value, notes });
    }
    const existing = await Lead.findOne({ userId, phone });
    if (existing) {
      return Lead.findByIdAndUpdate(
        existing._id,
        {
          $set: {
            ...(name && { name }),
            ...(email && { email }),
            ...(interest && { interest }),
            ...(status && { status }),
            ...(value && { value }),
            ...(notes && { notes: notes }),
            ...(callLogId && { callLogId }),
          },
        },
        { new: true }
      );
    }
    return Lead.create({ userId, agentId, callLogId, name, phone, email, interest, status, value, notes });
  }

  // ─── BEST-EFFORT / EXTERNAL-SYSTEM TOOLS ────────────────────────────────
  // These need an external system to be truly functional. Without a custom
  // serverUrl they return an honest "not_connected" payload so the agent
  // tells the caller it will follow up rather than inventing data.

  async getAvailability(input) {
    return {
      status: 'not_connected',
      message: 'Calendar not connected. Configure a serverUrl for this tool to fetch real availability.',
      requested: { service: input.service_type || input.appointmentType, date: input.date, doctor: input.doctor },
    };
  }

  async searchProperties(input) {
    return {
      status: 'not_connected',
      message: 'Property catalog not connected. Configure a serverUrl to enable live search.',
      criteria: input,
    };
  }

  async trackOrder(input) {
    return {
      status: 'not_connected',
      message: 'Order system not connected. Configure a serverUrl for this tool to fetch live order status.',
      orderId: input.orderId || null,
    };
  }

  async processReturn(input) {
    return {
      status: 'not_connected',
      message: 'Returns system not connected. Configure a serverUrl to process returns automatically.',
      orderId: input.orderId || null,
    };
  }

  async updateDeliveryStatus(input) {
    return {
      status: 'not_connected',
      message: 'Logistics system not connected. Configure a serverUrl to push delivery updates.',
      orderId: input.orderId || null,
    };
  }

  async contactDriver(input) {
    return {
      status: 'not_connected',
      message: 'Driver dispatch not connected. Configure a serverUrl to relay messages to drivers.',
      driverId: input.driverId || null,
    };
  }

  // ─── COMMS / MISC ───────────────────────────────────────────────────────

  async sendEmail({ to, subject }) {
    console.log(`📧 (stub) Email to ${to}: ${subject}`);
    return { status: 'not_connected', message: 'Email provider not connected. Configure a serverUrl to send email.' };
  }

  async sendSMS({ phone, message }) {
    console.log(`💬 (stub) SMS to ${phone}`);
    return {
      status: 'not_connected',
      message: 'SMS is sent via post-call actions. For mid-call SMS, configure a serverUrl for this tool.',
      preview: (message || '').slice(0, 60),
    };
  }

  async scheduleCall({ phone, time, purpose }) {
    return { status: 'noted', phone, time, purpose, message: 'Callback request noted.' };
  }

  async logCallNote({ note }, agentContext, callContext = {}) {
    // Persisted to the CallLog by the session layer; here we just acknowledge.
    return { status: 'logged', callLogId: callContext.callLogId || null, note };
  }

  async transferToAgent({ agentId, reason }) {
    console.log(`🔄 Handoff requested to agent ${agentId}: ${reason}`);
    return { status: 'transfer_initiated', __transferToAgentId: agentId, reason };
  }

  /**
   * Tool schemas for the generic built-in set (used when an agent opts into
   * platform tools without defining its own).
   */
  getToolSchemas() {
    return [
      {
        type: 'function',
        function: {
          name: 'create_ticket',
          description: 'Create a support ticket in the CRM for the caller',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Caller name' },
              phone: { type: 'string', description: 'Caller phone' },
              email: { type: 'string', description: 'Caller email' },
              issue: { type: 'string', description: 'Description of the issue' },
              priority: { type: 'string', enum: ['Low', 'Medium', 'High'] },
            },
            required: ['name', 'issue'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'capture_lead',
          description: 'Save the caller as a sales lead in the CRM',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              phone: { type: 'string' },
              email: { type: 'string' },
              interest: { type: 'string', description: 'What the lead is interested in' },
              budget: { type: 'string' },
              status: { type: 'string', enum: ['Hot', 'Warm', 'Cold'] },
            },
            required: ['name'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'book_appointment',
          description: 'Book an appointment and capture the caller in the CRM',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              phone: { type: 'string' },
              datetime: { type: 'string', description: 'Requested date/time' },
            },
            required: ['name', 'datetime'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'transfer_to_agent',
          description: 'Transfer the call to a specialized AI agent',
          parameters: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'Destination Agent ObjectId' },
              reason: { type: 'string', description: 'Reason for transfer' },
            },
            required: ['agentId', 'reason'],
          },
        },
      },
    ];
  }
}

module.exports = new ToolExecutor();
