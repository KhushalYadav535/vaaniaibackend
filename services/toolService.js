const axios = require('axios');

class ToolService {
  /**
   * Execute a tool/function call (Vapi/Retell style)
   */
  async executeTool(toolName, args, agent) {
    console.log(`[Tool] Executing ${toolName} with args:`, args);
    
    // Example: Stock Price Tool
    if (toolName === 'get_stock_price') {
      return { price: Math.floor(Math.random() * 1000) + 100, symbol: args.symbol };
    }
    
    // Example: Appointment Booking Tool
    if (toolName === 'book_appointment') {
      return { status: 'success', confirmation: 'APPT-' + Math.floor(Math.random() * 10000) };
    }

    // Custom Webhook Tool
    const webhook = agent.webhooks?.find(w => w.name === toolName);
    if (webhook) {
      try {
        const response = await axios.post(webhook.url, args, {
          headers: { 'Authorization': `Bearer ${webhook.token}` }
        });
        return response.data;
      } catch (e) {
        return { error: 'Webhook failed', message: e.message };
      }
    }

    return { error: 'Tool not found' };
  }
}

module.exports = new ToolService();
