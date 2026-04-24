/**
 * Tool Executor Service
 * Handles function calling for LLM agents
 * Executes tools called by the LLM and returns results for follow-up messages
 */

class ToolExecutor {
  constructor() {
    // Registry of available tools
    this.tools = {
      'send_email': this.sendEmail.bind(this),
      'schedule_call': this.scheduleCall.bind(this),
      'create_ticket': this.createTicket.bind(this),
      'get_customer_info': this.getCustomerInfo.bind(this),
      'update_customer_info': this.updateCustomerInfo.bind(this),
      'get_availability': this.getAvailability.bind(this),
      'book_appointment': this.bookAppointment.bind(this),
      'send_sms': this.sendSMS.bind(this),
      'log_call_note': this.logCallNote.bind(this),
      'transfer_to_agent': this.transferToAgent.bind(this),
    };
  }

  /**
   * Execute a tool call from the LLM
   */
  async executeTool({ toolName, toolInput, agentContext }) {
    try {
      // First check if it's a built-in tool
      if (this.tools[toolName]) {
        console.log(`🔧 Executing built-in tool: ${toolName}`, toolInput);
        const result = await this.tools[toolName](toolInput, agentContext);
        return {
          success: true,
          tool: toolName,
          result,
          timestamp: new Date().toISOString(),
        };
      }

      // Check if it's a custom tool with a webhook
      if (agentContext && agentContext.tools) {
        const customTool = agentContext.tools.find(t => t.function?.name === toolName);
        if (customTool && customTool.serverUrl) {
          console.log(`🔧 Executing custom webhook tool: ${toolName} at ${customTool.serverUrl}`);
          const axios = require('axios');
          const response = await axios.post(customTool.serverUrl, toolInput);
          return {
            success: true,
            tool: toolName,
            result: response.data,
            timestamp: new Date().toISOString(),
          };
        }
      }

      return {
        success: false,
        error: `Tool "${toolName}" not found or no serverUrl provided.`,
      };
    } catch (error) {
      console.error(`❌ Tool execution failed (${toolName}):`, error.message);
      return {
        success: false,
        tool: toolName,
        error: error.message,
      };
    }
  }

  /**
   * Execute multiple tool calls in sequence
   */
  async executeToolCalls({ toolCalls, agentContext }) {
    const results = [];
    
    for (const toolCall of toolCalls) {
      const result = await this.executeTool({
        toolName: toolCall.function?.name,
        toolInput: toolCall.function?.arguments || {},
        agentContext,
      });
      results.push(result);
    }

    return results;
  }

  // ─── TOOL IMPLEMENTATIONS ───────────────────────────────────────────────

  async sendEmail({ to, subject, body }, context) {
    // Placeholder: integrate with your email service
    console.log(`📧 Email to ${to}: ${subject}`);
    return {
      status: 'sent',
      to,
      subject,
      timestamp: new Date().toISOString(),
    };
  }

  async scheduleCall({ phone, time, purpose }, context) {
    // Placeholder: integrate with calendar/call scheduling service
    console.log(`📞 Scheduled call to ${phone} at ${time}`);
    return {
      status: 'scheduled',
      phone,
      time,
      purpose,
    };
  }

  async createTicket({ title, description, priority = 'normal' }, context) {
    // Placeholder: integrate with ticketing system (Jira, Linear, etc.)
    console.log(`🎫 Creating ticket: ${title}`);
    return {
      status: 'created',
      ticketId: `TICKET-${Date.now()}`,
      title,
      description,
      priority,
    };
  }

  async getCustomerInfo({ customerId }, context) {
    // Placeholder: fetch from database/CRM
    // In production, query your customer database
    console.log(`👤 Fetching info for customer ${customerId}`);
    return {
      customerId,
      name: 'John Doe',
      email: 'john@example.com',
      phone: '+1-555-0100',
      account_status: 'active',
      last_interaction: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async updateCustomerInfo({ customerId, updates }, context) {
    // Placeholder: update database/CRM
    console.log(`📝 Updating customer ${customerId}:`, updates);
    return {
      status: 'updated',
      customerId,
      updatedFields: Object.keys(updates),
      timestamp: new Date().toISOString(),
    };
  }

  async getAvailability({ service_type, date }, context) {
    // Placeholder: get availability from calendar
    console.log(`📅 Getting availability for ${service_type} on ${date}`);
    const slots = ['09:00 AM', '10:30 AM', '02:00 PM', '03:30 PM'];
    return {
      date,
      service_type,
      available_slots: slots,
    };
  }

  async bookAppointment({ customerId, time, service_type }, context) {
    // Placeholder: book in your system
    console.log(`✅ Booking appointment for ${customerId} at ${time}`);
    return {
      status: 'confirmed',
      appointmentId: `APT-${Date.now()}`,
      customerId,
      time,
      service_type,
      confirmation_sent: true,
    };
  }

  async sendSMS({ phone, message }, context) {
    // Placeholder: use Twilio/AWS SNS/etc
    console.log(`💬 SMS to ${phone}: ${message}`);
    return {
      status: 'sent',
      phone,
      messageId: `SMS-${Date.now()}`,
      characterCount: message.length,
    };
  }

  async logCallNote({ callId, note }, context) {
    // Placeholder: save note to call log
    console.log(`📝 Logging note for call ${callId}: ${note}`);
    return {
      status: 'logged',
      callId,
      note,
      timestamp: new Date().toISOString(),
    };
  }

  async transferToAgent({ agentId, reason }, context) {
    console.log(`🔄 Handoff requested to agent ${agentId} because: ${reason}`);
    return {
      status: 'transfer_initiated',
      __transferToAgentId: agentId,
      reason
    };
  }

  /**
   * Get available tools as function schemas for LLM
   */
  getToolSchemas() {
    return [
      {
        type: 'function',
        function: {
          name: 'send_email',
          description: 'Send an email to a customer',
          parameters: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Email address' },
              subject: { type: 'string', description: 'Email subject' },
              body: { type: 'string', description: 'Email body' },
            },
            required: ['to', 'subject', 'body'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'schedule_call',
          description: 'Schedule a callback for the customer',
          parameters: {
            type: 'object',
            properties: {
              phone: { type: 'string', description: 'Phone number to call' },
              time: { type: 'string', description: 'ISO 8601 datetime' },
              purpose: { type: 'string', description: 'Purpose of call' },
            },
            required: ['phone', 'time'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'create_ticket',
          description: 'Create a support ticket',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Ticket title' },
              description: { type: 'string', description: 'Detailed description' },
              priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
            },
            required: ['title', 'description'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_customer_info',
          description: 'Fetch customer information from database',
          parameters: {
            type: 'object',
            properties: {
              customerId: { type: 'string', description: 'Customer ID or email' },
            },
            required: ['customerId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'send_sms',
          description: 'Send SMS to a phone number',
          parameters: {
            type: 'object',
            properties: {
              phone: { type: 'string', description: 'Phone number' },
              message: { type: 'string', description: 'SMS message (max 160 chars)' },
            },
            required: ['phone', 'message'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'transfer_to_agent',
          description: 'Transfer the call to a specialized AI agent (e.g., Billing, Support, Sales)',
          parameters: {
            type: 'object',
            properties: {
              agentId: { type: 'string', description: 'The MongoDB ObjectId of the destination Agent' },
              reason: { type: 'string', description: 'Reason for transfer to provide context to the next agent' },
            },
            required: ['agentId', 'reason'],
          },
        },
      },
    ];
  }
}

module.exports = new ToolExecutor();
