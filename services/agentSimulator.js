/**
 * Agent Simulator
 *
 * Runs automated, text-based conversations between a synthetic "caller" (an
 * LLM playing a persona) and a real agent's brain (its systemPrompt + LLM
 * config), then grades the transcript against natural-language success
 * criteria. This is the Vapi "Simulations" / Retell "LLM Simulation Testing"
 * equivalent — no telephony, no audio, just the conversational logic.
 *
 * Everything runs on Groq (free tier), reusing groqService so the user's own
 * API key, circuit breaker, and timeouts all apply.
 */
const groqService = require('./groqService');
const ragService = require('./ragService');

const SIM_MODEL = process.env.SIM_MODEL || 'llama-3.1-8b-instant';
const GRADER_MODEL = process.env.SIM_GRADER_MODEL || 'llama-3.3-70b-versatile';

class AgentSimulator {
  /**
   * Generate the simulated caller's next message given the conversation so far.
   * The caller only sees the agent's messages as "the other party".
   */
  async callerTurn({ personaPrompt, history, apiKey }) {
    const messages = [
      {
        role: 'system',
        content:
          `You are role-playing as a phone caller talking to a customer-service voice agent. ` +
          `Stay fully in character and pursue your goal. Keep replies short and natural, like real speech (1-2 sentences). ` +
          `Do not break character or mention that you are an AI. When your goal is resolved or clearly refused, say a brief goodbye.\n\n` +
          `YOUR CHARACTER & GOAL:\n${personaPrompt}`,
      },
      // From the caller's POV, the agent is the "user" it's responding to.
      ...history.map((m) => ({
        role: m.role === 'caller' ? 'assistant' : 'user',
        content: m.text,
      })),
    ];

    const resp = await groqService.generateResponse({
      messages,
      model: SIM_MODEL,
      temperature: 0.8,
      apiKey,
    });
    return resp.text.trim();
  }

  /**
   * Generate the agent's next message using its real configuration.
   * Mirrors how the live voice pipeline prompts the LLM.
   */
  async agentTurn({ agent, history, apiKey, kbContext }) {
    const systemContent =
      `${agent.systemPrompt || 'You are a helpful voice assistant.'}` +
      (kbContext ? `\n${kbContext}` : '') +
      `\n\nKeep responses concise and conversational, as if speaking on a phone call.`;

    const messages = [
      { role: 'system', content: systemContent },
      ...history.map((m) => ({
        role: m.role === 'agent' ? 'assistant' : 'user',
        content: m.text,
      })),
    ];

    const start = Date.now();
    const resp = await groqService.generateResponse({
      messages,
      model: agent.llm?.model || SIM_MODEL,
      temperature: agent.temperature ?? 0.4,
      apiKey,
    });
    return { text: resp.text.trim(), latencyMs: Date.now() - start };
  }

  /**
   * Run one scenario end-to-end: drive the conversation, then grade it.
   */
  async runScenario({ agent, scenario, apiKey }) {
    const history = [];
    const latencies = [];
    const maxTurns = scenario.maxTurns || 6;

    try {
      // 1. Agent speaks first with its configured firstMessage (like a real call).
      if (agent.firstMessage) {
        history.push({ role: 'agent', text: agent.firstMessage });
      }

      // 2. Caller opens (explicit opening, or generated from persona).
      let callerMsg = scenario.openingMessage;
      if (!callerMsg) {
        callerMsg = await this.callerTurn({ personaPrompt: scenario.personaPrompt, history, apiKey });
      }
      history.push({ role: 'caller', text: callerMsg });

      // 3. Alternate turns until maxTurns or the caller says goodbye.
      for (let turn = 0; turn < maxTurns; turn++) {
        // Optional KB grounding, matching live-call behavior.
        let kbContext = '';
        if (agent.knowledgeBaseIds && agent.knowledgeBaseIds.length > 0) {
          kbContext = await ragService
            .getContextForQuery(callerMsg, agent.knowledgeBaseIds)
            .catch(() => '');
        }

        const agentReply = await this.agentTurn({ agent, history, apiKey, kbContext });
        history.push({ role: 'agent', text: agentReply.text });
        latencies.push(agentReply.latencyMs);

        callerMsg = await this.callerTurn({ personaPrompt: scenario.personaPrompt, history, apiKey });
        history.push({ role: 'caller', text: callerMsg });

        if (/\b(bye|goodbye|thank you, that'?s all|that'?s all i need)\b/i.test(callerMsg)) {
          break;
        }
      }

      // 4. Grade the transcript.
      const grade = await this.gradeTranscript({ scenario, transcript: history, apiKey });

      const latencyMsAvg = latencies.length
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;

      return {
        scenarioId: scenario._id,
        name: scenario.name,
        passed: grade.passed,
        score: grade.score,
        reasoning: grade.reasoning,
        criteriaResults: grade.criteriaResults,
        transcript: history,
        turns: latencies.length,
        latencyMsAvg,
        error: '',
      };
    } catch (e) {
      return {
        scenarioId: scenario._id,
        name: scenario.name,
        passed: false,
        score: 0,
        reasoning: '',
        criteriaResults: [],
        transcript: history,
        turns: latencies.length,
        latencyMsAvg: 0,
        error: e.message || 'simulation_error',
      };
    }
  }

  /**
   * Use a stronger LLM to grade the conversation against success criteria.
   * Returns { passed, score, reasoning, criteriaResults }.
   */
  async gradeTranscript({ scenario, transcript, apiKey }) {
    const criteria = (scenario.successCriteria || []).filter(Boolean);
    const transcriptText = transcript
      .map((m) => `${m.role === 'caller' ? 'Caller' : 'Agent'}: ${m.text}`)
      .join('\n');

    const criteriaList = criteria.length
      ? criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : '1. The agent was helpful, stayed on topic, and handled the caller professionally.';

    const grader = await groqService.generateResponse({
      messages: [
        {
          role: 'system',
          content:
            `You are a strict QA evaluator for customer-service voice agents. ` +
            `Given a conversation transcript and a list of success criteria, decide whether each criterion was met. ` +
            `Respond ONLY with JSON in this exact shape:\n` +
            `{"criteria":[{"criterion":"...","met":true}],"score":0-100,"passed":true,"reasoning":"one short paragraph"}\n` +
            `"passed" is true only if ALL criteria are met. "score" reflects overall quality.`,
        },
        {
          role: 'user',
          content: `SUCCESS CRITERIA:\n${criteriaList}\n\nTRANSCRIPT:\n${transcriptText}`,
        },
      ],
      model: GRADER_MODEL,
      temperature: 0,
      apiKey,
      jsonMode: true,
    });

    let parsed;
    try {
      parsed = JSON.parse(grader.text.replace(/```json|```/g, '').trim());
    } catch (_) {
      // If grading output is malformed, fail safe (not passed) with the raw text.
      return {
        passed: false,
        score: 0,
        reasoning: 'Grader returned unparseable output.',
        criteriaResults: criteria.map((c) => ({ criterion: c, met: false })),
      };
    }

    const criteriaResults = Array.isArray(parsed.criteria)
      ? parsed.criteria.map((c) => ({ criterion: String(c.criterion || ''), met: !!c.met }))
      : criteria.map((c) => ({ criterion: c, met: false }));

    const allMet = criteriaResults.length > 0 && criteriaResults.every((c) => c.met);

    return {
      passed: typeof parsed.passed === 'boolean' ? parsed.passed : allMet,
      score: Number.isFinite(parsed.score) ? Math.max(0, Math.min(100, parsed.score)) : (allMet ? 100 : 0),
      reasoning: String(parsed.reasoning || ''),
      criteriaResults,
    };
  }

  /**
   * Run every scenario in a suite sequentially and return an aggregate result.
   */
  async runSuite({ agent, scenarios, apiKey, onScenarioComplete }) {
    const results = [];
    for (const scenario of scenarios) {
      /* eslint-disable no-await-in-loop */
      const result = await this.runScenario({ agent, scenario, apiKey });
      results.push(result);
      if (typeof onScenarioComplete === 'function') {
        await onScenarioComplete(result, results.length, scenarios.length);
      }
    }

    const passed = results.filter((r) => r.passed).length;
    return {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length ? Number(((passed / results.length) * 100).toFixed(1)) : 0,
      results,
    };
  }
}

module.exports = new AgentSimulator();
