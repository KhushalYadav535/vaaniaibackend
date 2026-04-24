const BatchCall = require('../models/BatchCall');
const twilio = require('../routes/twilio'); // Twilio route/service
const CallLog = require('../models/CallLog');

class BatchCallService {
  /**
   * Start a scheduled batch call (Outbound at Scale)
   */
  async startBatch(batchId) {
    const batch = await BatchCall.findById(batchId).populate('agentId');
    if (!batch || batch.status !== 'scheduled') return;

    batch.status = 'running';
    await batch.save();

    console.log(`[Batch] Starting ${batch.name} with ${batch.contacts.length} contacts...`);

    // Process contacts with concurrency control
    const concurrency = batch.concurrency || 1;
    let index = 0;

    const runNext = async () => {
      if (index >= batch.contacts.length) {
        batch.status = 'completed';
        await batch.save();
        return;
      }

      const contact = batch.contacts[index++];
      contact.status = 'in_progress';
      await batch.save();

      try {
        // Trigger Twilio Call (Retell/Bland style)
        const call = await twilio.makeOutboundCall({
          to: contact.phone,
          agentId: batch.agentId._id,
          customVariables: contact.customVariables
        });

        contact.status = 'completed';
        contact.callId = call._id;
        batch.stats.completed++;
      } catch (e) {
        console.error(`[Batch] Error calling ${contact.phone}:`, e.message);
        contact.status = 'failed';
        contact.error = e.message;
        batch.stats.failed++;
      }

      await batch.save();
      // Wait for delay if needed (Vapi/Bland style)
      setTimeout(runNext, 2000); 
    };

    // Start initial concurrent workers
    for (let i = 0; i < concurrency; i++) {
      runNext();
    }
  }
}

module.exports = new BatchCallService();
