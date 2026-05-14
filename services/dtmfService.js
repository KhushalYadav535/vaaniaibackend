/**
 * DTMF (Dual-Tone Multi-Frequency) Service
 * Handles keypad input from Twilio calls for interactive voice responses.
 * Supports digit collection, menu navigation, and custom actions.
 * 
 * Use cases:
 * - "Press 1 for sales, 2 for support"
 * - PIN/verification code entry
 * - Queue position announcements
 * - Call routing based on input
 */

class DTMFService {
  constructor() {
    this.activeMenus = new Map(); // sessionId -> menu state
  }

  /**
   * Create a new DTMF menu
   */
  createMenu(sessionId, config) {
    const menu = {
      sessionId,
      ...config,
      state: {
        input: '',
        attempts: 0,
        maxAttempts: config.maxAttempts || 3,
        timeout: config.timeout || 5000,
        lastActivity: Date.now(),
      },
    };

    this.activeMenus.set(sessionId, menu);
    return menu;
  }

  /**
   * Get active menu for session
   */
  getMenu(sessionId) {
    return this.activeMenus.get(sessionId);
  }

  /**
   * Process DTMF digit input
   */
  processDigit(sessionId, digit) {
    const menu = this.activeMenus.get(sessionId);
    if (!menu) return null;

    menu.state.input += digit;
    menu.state.lastActivity = Date.now();

    // Check if we've reached expected length
    const expectedLength = menu.expectedDigits;
    if (expectedLength && menu.state.input.length >= expectedLength) {
      return this.completeInput(sessionId);
    }

    // Check for timeout
    if (Date.now() - menu.state.lastActivity > menu.state.timeout) {
      return this.handleTimeout(sessionId);
    }

    return {
      type: 'digit_received',
      digit,
      input: menu.state.input,
      prompt: this.getProgressPrompt(menu),
    };
  }

  /**
   * Complete input collection
   */
  completeInput(sessionId) {
    const menu = this.activeMenus.get(sessionId);
    if (!menu) return null;

    const input = menu.state.input;
    const action = this.findAction(menu, input);

    // Clear menu after completion
    this.activeMenus.delete(sessionId);

    return {
      type: 'input_complete',
      input,
      action,
      message: action?.message || this.getDefaultMessage(menu, input),
    };
  }

  /**
   * Handle input timeout
   */
  handleTimeout(sessionId) {
    const menu = this.activeMenus.get(sessionId);
    if (!menu) return null;

    menu.state.attempts++;

    if (menu.state.attempts >= menu.state.maxAttempts) {
      // Max attempts reached
      this.activeMenus.delete(sessionId);
      return {
        type: 'max_attempts_reached',
        message: menu.onTimeout || 'Goodbye.',
        action: { type: 'hangup' },
      };
    }

    // Retry
    menu.state.input = '';
    return {
      type: 'timeout_retry',
      attempt: menu.state.attempts,
      remaining: menu.state.maxAttempts - menu.state.attempts,
      prompt: menu.prompt || 'Please try again.',
    };
  }

  /**
   * Find action based on input
   */
  findAction(menu, input) {
    if (!menu.actions) return null;

    // Direct match
    let action = menu.actions[input];
    if (action) return action;

    // Pattern matching (for ranges, etc.)
    for (const [pattern, patternAction] of Object.entries(menu.actions)) {
      if (this.matchesPattern(input, pattern)) {
        return patternAction;
      }
    }

    // Default action
    return menu.actions.default || { type: 'invalid', message: 'Invalid selection.' };
  }

  /**
   * Check if input matches pattern
   */
  matchesPattern(input, pattern) {
    if (pattern.startsWith('#')) {
      // Range pattern: #1-3 matches 1, 2, 3
      const [start, end] = pattern.substring(1).split('-').map(Number);
      const num = parseInt(input);
      return !isNaN(num) && num >= start && num <= end;
    }
    return false;
  }

  /**
   * Get progress prompt during input collection
   */
  getProgressPrompt(menu) {
    const collected = menu.state.input.length;
    const total = menu.expectedDigits || 0;
    
    if (total > 0) {
      return `Entered ${collected} of ${total} digits`;
    }
    return `Entered: ${menu.state.input}`;
  }

  /**
   * Get default message for input
   */
  getDefaultMessage(menu, input) {
    if (menu.defaultMessage) {
      return menu.defaultMessage.replace('{input}', input);
    }
    return `You entered: ${input}`;
  }

  /**
   * Generate Twilio Gather TwiML
   */
  generateGatherTwiml(config) {
    const { prompt, timeout = 5, numDigits, finishOnKey = '#', actionUrl } = config;

    let twiml = '<Response>';
    
    if (prompt) {
      twiml += `<Say voice="alice">${this.escapeXml(prompt)}</Say>`;
    }

    const gatherAttrs = {
      timeout: timeout.toString(),
      action: actionUrl || '/api/twilio/dtmf',
      method: 'POST',
    };

    if (numDigits) gatherAttrs.numDigits = numDigits.toString();
    if (finishOnKey) gatherAttrs.finishOnKey = finishOnKey;

    const attrsStr = Object.entries(gatherAttrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');

    twiml += `<Gather ${attrsStr}></Gather>`;
    twiml += '</Response>';

    return twiml;
  }

  /**
   * Generate menu TwiML
   */
  generateMenuTwiml(sessionId, menu) {
    const twiml = this.generateGatherTwiml({
      prompt: menu.prompt,
      timeout: menu.state.timeout / 1000,
      numDigits: menu.expectedDigits,
      actionUrl: `/api/twilio/dtmf/${sessionId}`,
    });

    return twiml;
  }

  /**
   * Escape XML for TwiML
   */
  escapeXml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Create common menu templates
   */
  static getTemplates() {
    return {
      // Simple main menu
      mainMenu: {
        prompt: 'Press 1 for sales, 2 for support, or 3 to leave a message.',
        expectedDigits: 1,
        actions: {
          '1': { type: 'route', target: 'sales', message: 'Connecting you to sales...' },
          '2': { type: 'route', target: 'support', message: 'Connecting you to support...' },
          '3': { type: 'voicemail', message: 'Please leave a message after the tone.' },
          'default': { type: 'invalid', message: 'Invalid selection. Please try again.' },
        },
        maxAttempts: 3,
        timeout: 5000,
      },

      // PIN entry
      pinEntry: {
        prompt: 'Please enter your 4-digit PIN.',
        expectedDigits: 4,
        actions: {
          '#1-9999': { type: 'validate_pin', message: 'Validating PIN...' },
          'default': { type: 'invalid', message: 'Invalid PIN format.' },
        },
        maxAttempts: 3,
        timeout: 10000,
      },

      // Queue position
      queuePosition: {
        prompt: 'You are caller number 3. Press 1 to continue holding or 2 to request a callback.',
        expectedDigits: 1,
        actions: {
          '1': { type: 'continue_hold', message: 'Thank you for holding.' },
          '2': { type: 'callback', message: 'We will call you back shortly.' },
        },
        maxAttempts: 1,
        timeout: 3000,
      },
    };
  }

  /**
   * Clean up expired menus
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, menu] of this.activeMenus.entries()) {
      if (now - menu.state.lastActivity > 300000) { // 5 minutes
        this.activeMenus.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[DTMF] Cleaned ${cleaned} expired menus`);
    }
  }
}

// Create singleton
const dtmfService = new DTMFService();

// Periodic cleanup
setInterval(() => dtmfService.cleanup(), 60000); // Every minute

module.exports = dtmfService;
