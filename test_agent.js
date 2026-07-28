require('dotenv').config();
const mongoose = require('mongoose');
const openRouterService = require('./services/openRouterService');
const ragService = require('./services/ragService');

// We must require models for mongoose to know about them if ragService relies on them globally
// Typically they are in /models
try {
  require('./models/Agent');
  require('./models/KnowledgeBase');
} catch (e) {
  // Ignore if already loaded or paths differ
}

async function testAgent(agentName, query) {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/vocreddb';
  
  try {
    console.log(`⏳ Connecting to Mongoose...`);
    await mongoose.connect(uri);
    
    // Fallback to native driver just to fetch the agent easily without schema strictness
    const db = mongoose.connection.db;
    const agents = db.collection('agents');

    console.log(`\n🔍 Searching for agent: "${agentName}"...`);
    const agent = await agents.findOne({ name: new RegExp(agentName, 'i') });

    if (!agent) {
      console.log('❌ Agent not found in DB.');
      return;
    }

    console.log(`✅ Found Agent: ${agent.name} (ID: ${agent._id})`);
    
    let kbContext = '';
    if (agent.knowledgeBaseIds && agent.knowledgeBaseIds.length > 0) {
      console.log(`📚 Agent has ${agent.knowledgeBaseIds.length} Knowledge Base(s). Fetching context for query...`);
      try {
        kbContext = await ragService.getContextForQuery(query, agent.knowledgeBaseIds);
        console.log(`✅ Fetched RAG Context length: ${kbContext.length} chars`);
      } catch (err) {
        console.log(`⚠️ RAG Fetch failed: ${err.message}`);
      }
    }

    const systemContent =
      `${agent.systemPrompt || 'You are a helpful voice assistant.'}` +
      (kbContext ? `\n\n--- KNOWLEDGE BASE DATA ---\n${kbContext}` : '') +
      `\n\nKeep responses concise and conversational, as if speaking on a phone call.`;

    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: query }
    ];

    console.log(`\n🗣️ User Query: "${query}"`);
    console.log(`🤖 Generating response using OpenRouter (Model: ${agent.llm?.model || 'meta-llama/llama-4-scout'})...`);

    const start = Date.now();
    const resp = await openRouterService.generateResponse({
      messages,
      model: agent.llm?.model || 'meta-llama/llama-4-scout',
      temperature: agent.temperature ?? 0.4,
      apiKey: process.env.OPENROUTER_API_KEY
    });
    
    const latency = Date.now() - start;

    console.log(`\n================== RESPONSE ==================`);
    console.log(resp.text);
    console.log(`==============================================`);
    console.log(`⏱️ Latency: ${latency}ms | Provider: ${resp.provider || 'OpenRouter'}`);

  } catch (error) {
    console.error('❌ Error during test:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

const args = process.argv.slice(2);
const targetAgent = args[0] || 'mnsbank';
const userQuery = args[1] || 'मुझे car model के बारे में जानकारी दीजिए';

testAgent(targetAgent, userQuery);
