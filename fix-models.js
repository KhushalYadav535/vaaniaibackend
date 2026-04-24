const mongoose = require('mongoose');
const Agent = require('./models/Agent');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function fixModels() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
    
    // Find agents with deprecated model and update
    const result = await Agent.updateMany(
      { 'llm.model': 'llama3-8b-8192' },
      { $set: { 'llm.model': 'llama-3.1-8b-instant' } }
    );
    
    console.log(`Updated ${result.modifiedCount} agents that were using decommissioned model.`);
    
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

fixModels();
