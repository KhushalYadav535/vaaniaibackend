require('dotenv').config();
const mongoose = require('mongoose');
const CallLog = require('./models/CallLog');
const Agent = require('./models/Agent');

async function fixCallLogs() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const calls = await CallLog.find({});
    let updatedCount = 0;

    for (const call of calls) {
      if (!call.agentId) continue;
      
      const agent = await Agent.findById(call.agentId);
      if (agent && String(agent.userId) !== String(call.userId)) {
        call.userId = agent.userId;
        await call.save();
        updatedCount++;
        console.log(`Fixed CallLog ${call._id} - Assigned to Owner ${agent.userId}`);
      }
    }

    console.log(`\nSuccessfully fixed ${updatedCount} call logs!`);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

fixCallLogs();
