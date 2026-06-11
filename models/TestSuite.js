const mongoose = require('mongoose');

/**
 * A single scenario inside a test suite.
 *
 * The simulator drives a synthetic caller (an LLM playing `personaPrompt`)
 * against the agent for up to `maxTurns` exchanges, then grades the resulting
 * transcript against `successCriteria` (natural-language assertions).
 */
const scenarioSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // The persona/goal the simulated caller adopts, e.g.
  // "You are an annoyed customer whose internet is down. Demand a refund."
  personaPrompt: { type: String, required: true },
  // What the caller opens the conversation with (optional — the simulator
  // generates one from the persona when omitted).
  openingMessage: { type: String, default: '' },
  // Natural-language pass conditions checked by the grader LLM, e.g.
  // ["Agent offered to escalate", "Agent never promised a refund"].
  successCriteria: [{ type: String }],
  maxTurns: { type: Number, default: 6, min: 1, max: 20 },
}, { _id: true });

/**
 * Per-scenario result captured on each run.
 */
const scenarioResultSchema = new mongoose.Schema({
  scenarioId: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String },
  passed: { type: Boolean, default: false },
  score: { type: Number, default: 0 },        // 0–100 from grader
  reasoning: { type: String, default: '' },    // grader explanation
  criteriaResults: [{
    criterion: { type: String },
    met: { type: Boolean },
  }],
  transcript: [{
    role: { type: String, enum: ['caller', 'agent'] },
    text: { type: String },
  }],
  turns: { type: Number, default: 0 },
  latencyMsAvg: { type: Number, default: 0 },
  error: { type: String, default: '' },
}, { _id: false });

/**
 * A run is one execution of all scenarios in the suite against the agent.
 */
const runSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['queued', 'running', 'completed', 'failed'],
    default: 'queued',
  },
  total: { type: Number, default: 0 },
  passed: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  passRate: { type: Number, default: 0 },
  results: [scenarioResultSchema],
  startedAt: { type: Date, default: Date.now },
  finishedAt: { type: Date },
  error: { type: String, default: '' },
}, { _id: true, timestamps: true });

const testSuiteSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
  },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  scenarios: [scenarioSchema],
  // Most recent runs (capped — we keep history but trim in the route).
  runs: [runSchema],
  lastRunAt: { type: Date },
  lastPassRate: { type: Number, default: null },
}, { timestamps: true });

testSuiteSchema.index({ userId: 1, createdAt: -1 });
testSuiteSchema.index({ agentId: 1 });

module.exports = mongoose.model('TestSuite', testSuiteSchema);
