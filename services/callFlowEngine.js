/**
 * CallFlow Engine v2 — visual workflow executor.
 *
 * Walks a node/edge DAG produced by the @xyflow/react frontend builder
 * and yields chunks compatible with voicePipeline.processTextStream() so
 * voiceSession.js can stream TTS the same way for both engines.
 *
 * Yield contract (must match voicePipeline):
 *   { type: 'chunk', text }                 — speak this text
 *   { type: 'transfer', transferTo, reason} — human transfer
 *   { type: 'transfer_agent', agentId, reason } — squad handoff
 *   { type: 'end_call', message }           — hang up after speaking message
 *   { type: 'complete', response, latency } — flow turn complete
 *
 * Supported node types:
 *   trigger        — entry point (auto)
 *   speak          — TTS line(s); supports {{var}} substitution
 *   gather         — ask + extract variable from user reply
 *   dtmf           — capture keypad digits
 *   condition      — single if/else (true|false handles)
 *   switch         — multi-case (case_<val>|default handles)
 *   set_variable   — assign value (literal or expression)
 *   api / webhook  — HTTP call with retry, headers, body, HMAC signing
 *   llm            — open-ended LLM turn inside the flow
 *   extract        — extract structured data from transcript
 *   transfer       — human transfer
 *   transfer_agent — squad handoff to another agent
 *   jump           — jump to another node (loops)
 *   end            — terminate call
 *
 * Edges with sourceHandle === 'error' are taken when the source node throws.
 */

const groqService = require('./groqService');
const axios = require('axios');
const crypto = require('crypto');

const MAX_NODE_HOPS = Number(process.env.FLOW_MAX_NODE_HOPS || 200);
const NODE_DEFAULT_TIMEOUT_MS = Number(process.env.FLOW_NODE_TIMEOUT_MS || 8000);

class CallFlowEngine {
  initFlowState(callFlow) {
    const triggerNode = callFlow.nodes.find(n => n.type === 'trigger');
    return {
      activeNodeId: triggerNode ? triggerNode.id : null,
      variables: {},
      history: [],
      hops: 0,
      waitingForGather: false,
      waitingForDtmf: false,
    };
  }

  /**
   * Find the next node connected from a source handle. If no edge matches the
   * requested handle, falls back to the first unhandled edge so authors don't
   * have to wire every branch.
   */
  getNextNodeId(callFlow, sourceNodeId, sourceHandle = null) {
    const edges = callFlow.edges.filter(e => e.source === sourceNodeId);
    if (sourceHandle) {
      const exact = edges.find(e => e.sourceHandle === sourceHandle);
      if (exact) return exact.target;
    }
    const unhandled = edges.find(e => !e.sourceHandle);
    return unhandled ? unhandled.target : null;
  }

  getErrorNodeId(callFlow, sourceNodeId) {
    const edge = callFlow.edges.find(e => e.source === sourceNodeId && e.sourceHandle === 'error');
    return edge ? edge.target : null;
  }

  replaceVariables(text, variables) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, varPath) => {
      const value = this._getNested(variables, varPath);
      return value !== undefined && value !== null ? String(value) : '';
    });
  }

  _getNested(obj, path) {
    return path.split('.').reduce((acc, k) => (acc != null ? acc[k] : undefined), obj);
  }

  /**
   * Wrap a node-execution promise in a hard timeout.
   */
  _withTimeout(p, ms, label) {
    return Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms)),
    ]);
  }

  /**
   * Compare values for condition / switch nodes. Strings are compared
   * case-insensitively; numbers fall through to JS coercion.
   */
  _compare(a, op, b) {
    const sa = a == null ? '' : String(a).toLowerCase();
    const sb = b == null ? '' : String(b).toLowerCase();
    switch (op) {
      case 'equals':       return sa === sb;
      case 'not_equals':   return sa !== sb;
      case 'contains':     return sa.includes(sb);
      case 'not_contains': return !sa.includes(sb);
      case 'starts_with':  return sa.startsWith(sb);
      case 'ends_with':    return sa.endsWith(sb);
      case 'exists':       return a !== undefined && a !== null && a !== '';
      case 'not_exists':   return a === undefined || a === null || a === '';
      case 'gt':           return Number(a) >  Number(b);
      case 'gte':          return Number(a) >= Number(b);
      case 'lt':           return Number(a) <  Number(b);
      case 'lte':          return Number(a) <= Number(b);
      case 'regex':
        try { return new RegExp(b, 'i').test(sa); } catch { return false; }
      default: return false;
    }
  }

  async _executeApi(node, state) {
    const method = (node.data.method || 'GET').toUpperCase();
    const url = this.replaceVariables(node.data.url, state.variables);

    let headers = { 'Content-Type': 'application/json' };
    if (node.data.headers) {
      try {
        const parsed = typeof node.data.headers === 'string'
          ? JSON.parse(this.replaceVariables(node.data.headers, state.variables))
          : node.data.headers;
        headers = { ...headers, ...parsed };
      } catch (_) { /* malformed headers — ignore */ }
    }

    let data = null;
    if (node.data.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      const bodyStr = this.replaceVariables(node.data.body, state.variables);
      try { data = JSON.parse(bodyStr); } catch { data = bodyStr; }
    }

    // HMAC signing if a secret is configured on the node.
    if (node.data.secret) {
      const ts = Date.now().toString();
      const payload = JSON.stringify(data || {});
      const sig = crypto.createHmac('sha256', node.data.secret).update(`${ts}.${payload}`).digest('hex');
      headers['X-Signature']   = `sha256=${sig}`;
      headers['X-Timestamp']   = ts;
    }

    const timeout = Number(node.data.timeoutMs) || NODE_DEFAULT_TIMEOUT_MS;
    const maxRetries = Number(node.data.maxRetries) || 0;

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await axios({ method, url, headers, data, timeout });
        return { status: res.status, body: res.data };
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetries) {
          const backoff = 200 * Math.pow(2, attempt); // 200ms, 400ms, 800ms...
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }
    throw lastErr;
  }

  async _executeLlmExtract({ transcript, prompt, schema }) {
    // Build a tight extraction prompt — JSON-only response.
    const fields = (schema || []).map(f =>
      `  "${f.name}": ${f.type === 'number' ? '<number>' : f.type === 'boolean' ? '<true|false>' : '<string>'}`
    ).join(',\n');
    const extractPrompt = `${prompt || 'Extract the following fields from the user message.'}

User message: "${transcript}"

Return ONLY valid JSON, no markdown:
{
${fields}
}

If a field is not present, set it to null.`;

    const res = await groqService.generateResponse({
      messages: [
        { role: 'system', content: 'You are a strict JSON extractor. Reply with ONLY valid JSON, nothing else.' },
        { role: 'user', content: extractPrompt },
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0,
      jsonMode: true,
    });
    const clean = res.text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  }

  /**
   * Drive the flow forward. Yields chunks for the streaming WS layer.
   *
   * `transcript` is the user's last utterance (or empty if this is the
   * initial step). When a `gather` or `dtmf` node is waiting, the next
   * call resumes from there.
   */
  async *processFlowStep(session, transcript, callFlow) {
    if (!session.currentFlowState) {
      session.currentFlowState = this.initFlowState(callFlow);
    }
    const state = session.currentFlowState;
    state.hops = 0;

    let didYieldSomething = false;

    while (state.activeNodeId && state.hops < MAX_NODE_HOPS) {
      state.hops++;
      const node = callFlow.nodes.find(n => n.id === state.activeNodeId);
      if (!node) {
        console.warn(`[FlowEngine] Dangling edge — node ${state.activeNodeId} not found`);
        break;
      }
      console.log(`[FlowEngine] Hop ${state.hops}: ${node.type} (${node.id})`);

      try {
        switch (node.type) {
          // ─────────── Entry point ───────────
          case 'trigger':
            state.activeNodeId = this.getNextNodeId(callFlow, node.id);
            break;

          // ─────────── Speak ───────────
          case 'speak': {
            const textToSpeak = this.replaceVariables(node.data.text || '', state.variables);
            if (textToSpeak.trim()) {
              yield { type: 'chunk', text: textToSpeak };
              didYieldSomething = true;
            }
            state.activeNodeId = this.getNextNodeId(callFlow, node.id);
            // Pause if the next node also speaks something — let user hear this first.
            // Continue if it's a logic node (condition/api/set_variable etc).
            const nextNode = state.activeNodeId && callFlow.nodes.find(n => n.id === state.activeNodeId);
            if (!nextNode || ['speak', 'gather', 'dtmf', 'llm', 'transfer', 'transfer_agent', 'end'].includes(nextNode.type)) {
              // Pause after speaking when the next step is also user-facing
              if (nextNode && ['gather', 'dtmf'].includes(nextNode.type)) break; // fall through into the wait loop below
              if (!nextNode || nextNode.type === 'end' || nextNode.type === 'transfer' || nextNode.type === 'transfer_agent') break;
              // For a chain of 'speak' nodes we keep going.
            }
            break;
          }

          // ─────────── Gather (ask + extract) ───────────
          case 'gather': {
            if (!state.waitingForGather) {
              const prompt = this.replaceVariables(node.data.prompt || '', state.variables);
              if (prompt.trim()) {
                yield { type: 'chunk', text: prompt };
                didYieldSomething = true;
              }
              state.waitingForGather = true;
              return; // hand control back to the WS layer until next user turn
            }
            state.waitingForGather = false;
            if (transcript) {
              const variableName = node.data.variable || 'extracted_value';
              const expectedType = node.data.expectedType || 'text';
              try {
                const extracted = await this._withTimeout(
                  this._extractSingle(transcript, variableName, expectedType),
                  Number(node.data.timeoutMs) || NODE_DEFAULT_TIMEOUT_MS,
                  'gather_extract'
                );
                if (extracted !== null) state.variables[variableName] = extracted;
              } catch (e) {
                console.error('[FlowEngine] gather extract failed:', e.message);
              }
            }
            state.activeNodeId = this.getNextNodeId(callFlow, node.id);
            break;
          }

          // ─────────── DTMF capture ───────────
          case 'dtmf': {
            if (!state.waitingForDtmf) {
              const prompt = this.replaceVariables(node.data.prompt || '', state.variables);
              if (prompt.trim()) {
                yield { type: 'chunk', text: prompt };
                didYieldSomething = true;
              }
              state.waitingForDtmf = true;
              return;
            }
            state.waitingForDtmf = false;
            const digits = session._lastDtmf || transcript.replace(/\D/g, '');
            session._lastDtmf = '';
            const variableName = node.data.variable || 'dtmf_digits';
            state.variables[variableName] = digits;
            // If node defines digit-specific routing, use it as a switch.
            if (node.data.routes && typeof node.data.routes === 'object') {
              const handle = node.data.routes[digits] || 'default';
              state.activeNodeId = this.getNextNodeId(callFlow, node.id, handle);
            } else {
              state.activeNodeId = this.getNextNodeId(callFlow, node.id);
            }
            break;
          }

          // ─────────── Condition ───────────
          case 'condition': {
            const variableToTest = this._getNested(state.variables, node.data.variable);
            const operator = node.data.operator;
            const value = this.replaceVariables(node.data.value, state.variables);
            const result = this._compare(variableToTest, operator, value);
            state.activeNodeId = this.getNextNodeId(callFlow, node.id, result ? 'true' : 'false');
            break;
          }

          // ─────────── Switch (multi-case) ───────────
          case 'switch': {
            const variableValue = this._getNested(state.variables, node.data.variable);
            const sv = variableValue == null ? '' : String(variableValue).toLowerCase();
            const cases = Array.isArray(node.data.cases) ? node.data.cases : [];
            const matched = cases.find(c => String(c.value).toLowerCase() === sv);
            const handle = matched ? `case_${matched.value}` : 'default';
            state.activeNodeId = this.getNextNodeId(callFlow, node.id, handle);
            break;
          }

          // ─────────── Set variable ───────────
          case 'set_variable': {
            const name = node.data.name;
            if (!name) { state.activeNodeId = this.getNextNodeId(callFlow, node.id); break; }
            const raw = node.data.value;
            const val = typeof raw === 'string'
              ? this.replaceVariables(raw, state.variables)
              : raw;
            state.variables[name] = val;
            state.activeNodeId = this.getNextNodeId(callFlow, node.id);
            break;
          }

          // ─────────── API / Webhook ───────────
          case 'api':
          case 'webhook': {
            try {
              const resp = await this._withTimeout(
                this._executeApi(node, state),
                Number(node.data.timeoutMs) || NODE_DEFAULT_TIMEOUT_MS,
                'api'
              );
              const resultVar = node.data.resultVariable || 'api_result';
              state.variables[resultVar] = resp.body;
              state.variables[`${resultVar}_status`] = resp.status;
              state.activeNodeId = this.getNextNodeId(callFlow, node.id);
            } catch (e) {
              console.error('[FlowEngine] API failed:', e.message);
              const resultVar = node.data.resultVariable || 'api_result';
              state.variables[`${resultVar}_error`] = e.message;
              const errId = this.getErrorNodeId(callFlow, node.id);
              state.activeNodeId = errId || this.getNextNodeId(callFlow, node.id);
            }
            break;
          }

          // ─────────── LLM turn ───────────
          case 'llm': {
            try {
              const userPrompt = this.replaceVariables(node.data.prompt || transcript || '', state.variables);
              const sys = this.replaceVariables(node.data.system || 'You are a helpful voice agent.', state.variables);
              const res = await this._withTimeout(
                groqService.generateResponse({
                  messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: userPrompt },
                  ],
                  model: node.data.model || 'llama-3.1-8b-instant',
                  temperature: Number(node.data.temperature ?? 0.4),
                }),
                Number(node.data.timeoutMs) || NODE_DEFAULT_TIMEOUT_MS,
                'llm'
              );
              const text = (res.text || '').trim();
              if (text) {
                yield { type: 'chunk', text };
                didYieldSomething = true;
              }
              if (node.data.resultVariable) state.variables[node.data.resultVariable] = text;
              state.activeNodeId = this.getNextNodeId(callFlow, node.id);
            } catch (e) {
              console.error('[FlowEngine] LLM node failed:', e.message);
              const errId = this.getErrorNodeId(callFlow, node.id);
              state.activeNodeId = errId || this.getNextNodeId(callFlow, node.id);
            }
            break;
          }

          // ─────────── Structured data extraction ───────────
          case 'extract': {
            try {
              const schema = node.data.schema || [];
              const sourceText = transcript || node.data.source || '';
              const extracted = await this._withTimeout(
                this._executeLlmExtract({ transcript: sourceText, prompt: node.data.prompt, schema }),
                Number(node.data.timeoutMs) || NODE_DEFAULT_TIMEOUT_MS,
                'extract'
              );
              const target = node.data.resultVariable || 'extracted';
              state.variables[target] = extracted;
              // Also flatten into top-level variables for easier {{name}} substitution
              for (const [k, v] of Object.entries(extracted || {})) state.variables[k] = v;
              state.activeNodeId = this.getNextNodeId(callFlow, node.id);
            } catch (e) {
              console.error('[FlowEngine] extract failed:', e.message);
              const errId = this.getErrorNodeId(callFlow, node.id);
              state.activeNodeId = errId || this.getNextNodeId(callFlow, node.id);
            }
            break;
          }

          // ─────────── Transfer to human ───────────
          case 'transfer':
            yield {
              type: 'transfer',
              transferTo: this.replaceVariables(node.data.transferTo || '', state.variables) || 'Human Agent',
              reason: this.replaceVariables(node.data.reason || 'Requested by workflow', state.variables),
            };
            didYieldSomething = true;
            state.activeNodeId = null;
            return;

          // ─────────── Transfer to agent (Squad) ───────────
          case 'transfer_agent':
            yield {
              type: 'transfer_agent',
              agentId: node.data.agentId,
              reason: this.replaceVariables(node.data.reason || 'Workflow handoff', state.variables),
            };
            didYieldSomething = true;
            state.activeNodeId = null;
            return;

          // ─────────── Jump (loops / shared subgraphs) ───────────
          case 'jump':
            state.activeNodeId = node.data.targetNodeId || this.getNextNodeId(callFlow, node.id);
            break;

          // ─────────── End call ───────────
          case 'end':
            yield {
              type: 'end_call',
              message: this.replaceVariables(node.data.message || '', state.variables),
            };
            didYieldSomething = true;
            state.activeNodeId = null;
            return;

          default:
            console.warn(`[FlowEngine] Unknown node type: ${node.type}`);
            state.activeNodeId = this.getNextNodeId(callFlow, node.id);
            break;
        }
      } catch (err) {
        console.error(`[FlowEngine] Node ${node.id} (${node.type}) threw:`, err.message);
        const errId = this.getErrorNodeId(callFlow, node.id);
        if (errId) {
          state.activeNodeId = errId;
          continue;
        }
        // No error edge — apologize and exit gracefully.
        yield { type: 'chunk', text: "Sorry, something went wrong. Let me try again." };
        didYieldSomething = true;
        state.activeNodeId = null;
        break;
      }
    }

    if (state.hops >= MAX_NODE_HOPS) {
      console.warn(`[FlowEngine] Max hops (${MAX_NODE_HOPS}) reached — possible infinite loop`);
    }

    yield { type: 'complete', response: '', latency: { total: 0 } };
  }

  /**
   * Single-field extraction used by `gather` nodes.
   * Returns null when the LLM couldn't extract a value.
   */
  async _extractSingle(transcript, variableName, expectedType) {
    const extractPrompt = `Extract the value for "${variableName}" (type: ${expectedType}) from the user's speech.
User speech: "${transcript}"
Reply ONLY with the extracted value in plain text. If you cannot extract it, reply with "UNKNOWN".`;

    let response;
    if (typeof groqService.generateCompletion === 'function') {
      response = await groqService.generateCompletion(
        [{ role: 'user', content: extractPrompt }],
        'llama-3.1-8b-instant',
        0.1
      );
    } else {
      const r = await groqService.generateResponse({
        messages: [{ role: 'user', content: extractPrompt }],
        model: 'llama-3.1-8b-instant',
        temperature: 0.1,
      });
      response = { content: r.text };
    }
    const extracted = (response.content || '').trim();
    if (!extracted || extracted === 'UNKNOWN') return null;

    if (expectedType === 'boolean') {
      const lower = extracted.toLowerCase();
      return lower.includes('yes') || lower === 'true' || lower.includes('haan') || lower.includes('haa');
    }
    if (expectedType === 'number') {
      const num = Number(extracted.replace(/[^\d.-]/g, ''));
      return Number.isFinite(num) ? num : null;
    }
    return extracted;
  }
}

module.exports = new CallFlowEngine();
