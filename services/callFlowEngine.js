const groqService = require('./groqService');

class CallFlowEngine {
  /**
   * Initialize a new flow state for a session
   */
  initFlowState(callFlow) {
    // Find trigger node
    const triggerNode = callFlow.nodes.find(n => n.type === 'trigger');
    
    return {
      activeNodeId: triggerNode ? triggerNode.id : null,
      variables: {},
      history: []
    };
  }

  /**
   * Find the next node connected to a specific source handle or general connection
   */
  getNextNodeId(callFlow, sourceNodeId, sourceHandle = null) {
    const edge = callFlow.edges.find(e => {
      if (e.source !== sourceNodeId) return false;
      if (sourceHandle && e.sourceHandle !== sourceHandle) return false;
      return true;
    });
    return edge ? edge.target : null;
  }

  /**
   * Process a step in the visual call flow using a generator
   * This yields chunks similar to voicePipeline so voiceSession.js can stream TTS
   */
  async *processFlowStep(session, transcript, callFlow) {
    if (!session.currentFlowState) {
      session.currentFlowState = this.initFlowState(callFlow);
    }

    let state = session.currentFlowState;
    let keepProcessing = true;
    let didYieldSomething = false;

    while (keepProcessing && state.activeNodeId) {
      const node = callFlow.nodes.find(n => n.id === state.activeNodeId);
      if (!node) break;

      console.log(`[FlowEngine] Executing Node: ${node.type} (${node.id})`);

      switch (node.type) {
        case 'trigger':
          // Just move to the next node immediately
          state.activeNodeId = this.getNextNodeId(callFlow, node.id);
          break;

        case 'speak':
          // Yield the text for TTS
          const textToSpeak = this.replaceVariables(node.data.text || '', state.variables);
          yield { type: 'chunk', text: textToSpeak };
          didYieldSomething = true;
          // Move to next node immediately
          state.activeNodeId = this.getNextNodeId(callFlow, node.id);
          keepProcessing = false; // Pause here so the user can hear it before we do anything else (unless next is an API call, but we'll pause for simplicity)
          break;

        case 'gather':
          // If we just entered gather, we don't have transcript yet for THIS step
          if (!session.currentFlowState.waitingForGather) {
            // Ask the question first
            const prompt = this.replaceVariables(node.data.prompt || '', state.variables);
            if (prompt) {
               yield { type: 'chunk', text: prompt };
               didYieldSomething = true;
            }
            session.currentFlowState.waitingForGather = true;
            keepProcessing = false; // Pause and wait for user to speak
          } else {
            // User spoke, let's extract the variable
            session.currentFlowState.waitingForGather = false;
            
            if (transcript) {
               const variableName = node.data.variable || 'extracted_value';
               const expectedType = node.data.expectedType || 'text'; // 'text', 'boolean', 'number', 'intent'
               
               // Use small LLM call to extract
               const extractPrompt = `
                 Extract the value for "${variableName}" (type: ${expectedType}) from the user's speech.
                 User speech: "${transcript}"
                 
                 If the user is answering a question, what is their core answer?
                 Reply ONLY with the extracted value in plain text. If you cannot extract it, reply with "UNKNOWN".
               `;
               
               try {
                 const response = await groqService.generateCompletion(
                   [{ role: 'user', content: extractPrompt }], 
                   'llama-3.1-8b-instant', 
                   0.1
                 );
                 
                 let extracted = response.content.trim();
                 if (extracted !== 'UNKNOWN') {
                    if (expectedType === 'boolean') {
                       extracted = extracted.toLowerCase().includes('yes') || extracted.toLowerCase() === 'true';
                    }
                    state.variables[variableName] = extracted;
                 }
               } catch (err) {
                 console.error('[FlowEngine] Gather extraction error', err);
               }
            }
            
            // Move to next node
            state.activeNodeId = this.getNextNodeId(callFlow, node.id);
          }
          break;

        case 'condition':
          // Evaluate condition
          const variableToTest = state.variables[node.data.variable];
          const operator = node.data.operator; // 'equals', 'contains', 'exists'
          const value = node.data.value;
          
          let result = false;
          if (operator === 'equals' && String(variableToTest).toLowerCase() === String(value).toLowerCase()) result = true;
          if (operator === 'contains' && String(variableToTest).toLowerCase().includes(String(value).toLowerCase())) result = true;
          if (operator === 'exists' && variableToTest !== undefined && variableToTest !== null) result = true;
          
          const handle = result ? 'true' : 'false';
          state.activeNodeId = this.getNextNodeId(callFlow, node.id, handle);
          break;

        case 'api':
          // Basic API request simulation
          try {
             // In a real scenario, use axios. For now, we will mock or use basic fetch
             console.log(`[FlowEngine] Calling API: ${node.data.url}`);
             // state.variables['api_result'] = ...
          } catch (e) {
             console.error(e);
          }
          state.activeNodeId = this.getNextNodeId(callFlow, node.id);
          break;

        case 'transfer':
          // Send transfer event
          yield { 
            type: 'transfer', 
            transferTo: node.data.transferTo || 'Human Agent',
            reason: node.data.reason || 'Requested by workflow'
          };
          didYieldSomething = true;
          keepProcessing = false;
          state.activeNodeId = null; // End flow
          break;

        case 'end':
          yield { type: 'end_call', message: node.data.message };
          didYieldSomething = true;
          keepProcessing = false;
          state.activeNodeId = null;
          break;

        default:
          console.warn(`[FlowEngine] Unknown node type: ${node.type}`);
          state.activeNodeId = null;
          break;
      }
    }

    if (!didYieldSomething && !state.activeNodeId) {
      // Flow ended without yielding anything final
      yield { type: 'complete', response: '', latency: { total: 0 } };
    } else {
      yield { type: 'complete', response: '', latency: { total: 100 } };
    }
  }

  replaceVariables(text, variables) {
    if (!text) return text;
    return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, varName) => {
      return variables[varName] !== undefined ? variables[varName] : match;
    });
  }
}

module.exports = new CallFlowEngine();
