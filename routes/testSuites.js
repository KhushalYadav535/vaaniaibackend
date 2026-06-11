const express = require('express');
const router = express.Router();
const TestSuite = require('../models/TestSuite');
const Agent = require('../models/Agent');
const simulator = require('../services/agentSimulator');
const { protect } = require('../middleware/auth');

router.use(protect);

const MAX_RUN_HISTORY = Number(process.env.TEST_SUITE_MAX_RUNS || 10);

async function ownsAgent(userId, agentId) {
  const agent = await Agent.findOne({ _id: agentId, userId });
  return agent || null;
}

// @route   GET /api/test-suites
// @desc    List all test suites (without heavy run transcripts)
router.get('/', async (req, res, next) => {
  try {
    const suites = await TestSuite.find({ userId: req.user._id })
      .populate('agentId', 'name')
      .select('-runs.results.transcript')
      .sort('-createdAt');
    res.json({ success: true, count: suites.length, suites });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/test-suites/:id
// @desc    Get a single suite with full run history
router.get('/:id', async (req, res, next) => {
  try {
    const suite = await TestSuite.findOne({ _id: req.params.id, userId: req.user._id })
      .populate('agentId', 'name');
    if (!suite) return res.status(404).json({ success: false, message: 'Test suite not found' });
    res.json({ success: true, suite });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/test-suites
// @desc    Create a test suite
router.post('/', async (req, res, next) => {
  try {
    const { name, description, agentId, scenarios } = req.body;
    if (!name || !agentId) {
      return res.status(400).json({ success: false, message: 'name and agentId are required' });
    }
    if (!(await ownsAgent(req.user._id, agentId))) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const suite = await TestSuite.create({
      userId: req.user._id,
      agentId,
      name,
      description: description || '',
      scenarios: Array.isArray(scenarios) ? scenarios : [],
    });

    res.status(201).json({ success: true, suite });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/test-suites/:id
// @desc    Update suite metadata / scenarios
router.put('/:id', async (req, res, next) => {
  try {
    const { name, description, agentId, scenarios } = req.body;

    if (agentId && !(await ownsAgent(req.user._id, agentId))) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const update = {};
    if (name !== undefined) update.name = name;
    if (description !== undefined) update.description = description;
    if (agentId !== undefined) update.agentId = agentId;
    if (Array.isArray(scenarios)) update.scenarios = scenarios;

    const suite = await TestSuite.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      update,
      { new: true, runValidators: true }
    );
    if (!suite) return res.status(404).json({ success: false, message: 'Test suite not found' });

    res.json({ success: true, suite });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/test-suites/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const suite = await TestSuite.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!suite) return res.status(404).json({ success: false, message: 'Test suite not found' });
    res.json({ success: true, message: 'Test suite deleted' });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/test-suites/:id/run
// @desc    Kick off a simulation run (executes in background). Returns runId
//          immediately; poll GET /:id/runs/:runId for progress.
router.post('/:id/run', async (req, res, next) => {
  try {
    const suite = await TestSuite.findOne({ _id: req.params.id, userId: req.user._id });
    if (!suite) return res.status(404).json({ success: false, message: 'Test suite not found' });
    if (!suite.scenarios || suite.scenarios.length === 0) {
      return res.status(400).json({ success: false, message: 'Add at least one scenario before running' });
    }

    const agent = await Agent.findOne({ _id: suite.agentId, userId: req.user._id });
    if (!agent) return res.status(404).json({ success: false, message: 'Agent not found' });

    // Create a queued run record at the front of history.
    const run = {
      status: 'running',
      total: suite.scenarios.length,
      passed: 0,
      failed: 0,
      passRate: 0,
      results: [],
      startedAt: new Date(),
    };
    suite.runs.unshift(run);
    if (suite.runs.length > MAX_RUN_HISTORY) suite.runs = suite.runs.slice(0, MAX_RUN_HISTORY);
    await suite.save();
    const runId = suite.runs[0]._id;

    res.status(202).json({ success: true, runId, message: 'Simulation started' });

    // ─── Background execution ───────────────────────────────────────────────
    const apiKey = req.user.settings?.groqKey || process.env.GROQ_API_KEY;

    (async () => {
      try {
        const agg = await simulator.runSuite({
          agent,
          scenarios: suite.scenarios,
          apiKey,
          onScenarioComplete: async (result) => {
            // Incrementally persist progress so the UI can poll live.
            await TestSuite.updateOne(
              { _id: suite._id, 'runs._id': runId },
              {
                $push: { 'runs.$.results': result },
                $inc: {
                  'runs.$.passed': result.passed ? 1 : 0,
                  'runs.$.failed': result.passed ? 0 : 1,
                },
              }
            ).catch((e) => console.error('[TestSuite] progress save failed:', e.message));
          },
        });

        await TestSuite.updateOne(
          { _id: suite._id, 'runs._id': runId },
          {
            $set: {
              'runs.$.status': 'completed',
              'runs.$.passed': agg.passed,
              'runs.$.failed': agg.failed,
              'runs.$.passRate': agg.passRate,
              'runs.$.finishedAt': new Date(),
              lastRunAt: new Date(),
              lastPassRate: agg.passRate,
            },
          }
        );
      } catch (e) {
        console.error('[TestSuite] run failed:', e.message);
        await TestSuite.updateOne(
          { _id: suite._id, 'runs._id': runId },
          { $set: { 'runs.$.status': 'failed', 'runs.$.error': e.message, 'runs.$.finishedAt': new Date() } }
        ).catch(() => {});
      }
    })();
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/test-suites/:id/runs/:runId
// @desc    Poll a single run's progress/results
router.get('/:id/runs/:runId', async (req, res, next) => {
  try {
    const suite = await TestSuite.findOne(
      { _id: req.params.id, userId: req.user._id },
      { runs: { $elemMatch: { _id: req.params.runId } }, name: 1, agentId: 1 }
    );
    if (!suite || !suite.runs || suite.runs.length === 0) {
      return res.status(404).json({ success: false, message: 'Run not found' });
    }
    res.json({ success: true, run: suite.runs[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
