/**
 * Enhanced Error Handler Middleware
 * Gracefully handles errors with proper logging and recovery
 */

class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Async wrapper for route handlers
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Enhanced error handler middleware
 */
const errorHandler = (err, req, res, next) => {
  const error = err instanceof AppError
    ? err
    : new AppError(err.message || 'Internal Server Error', err.statusCode || 500);

  // Log error with context
  console.error(`
    ❌ [ERROR] ${new Date().toISOString()}
    Status: ${error.statusCode}
    Message: ${error.message}
    Path: ${req.path}
    Method: ${req.method}
    User: ${req.user?._id || 'anonymous'}
    ${error.stack}
  `);

  // Send error response
  res.status(error.statusCode || 500).json({
    success: false,
    error: {
      message: error.message,
      statusCode: error.statusCode,
      timestamp: error.timestamp,
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
    },
  });
};

/**
 * Graceful fallback handler for voice calls
 */
const voiceErrorFallback = async (error, session) => {
  try {
    if (session?.ws && session.ws.readyState === 1) {
      session.ws.send(JSON.stringify({
        type: 'error',
        message: 'Connection interrupted. Please try again.',
        recoverable: true,
      }));

      // Attempt graceful recovery
      if (session.callLogId) {
        const CallLog = require('../models/CallLog');
        await CallLog.findByIdAndUpdate(session.callLogId, {
          status: 'error',
          error: error.message,
          errorRecoveryAttempted: true,
        });
      }
    }
  } catch (recoveryError) {
    console.error('Error recovery failed:', recoveryError.message);
  }
};

/**
 * Retry logic with exponential backoff
 */
const retryWithBackoff = async (
  fn,
  maxRetries = 3,
  initialDelayMs = 100,
  maxDelayMs = 5000
) => {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries - 1) {
        // Calculate exponential backoff
        const delayMs = Math.min(
          initialDelayMs * Math.pow(2, attempt),
          maxDelayMs
        );
        
        console.warn(
          `⚠️ Attempt ${attempt + 1} failed. Retrying in ${delayMs}ms...`,
          error.message
        );
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new AppError(`Operation failed after ${maxRetries} attempts: ${lastError.message}`, 500);
};

/**
 * Graceful timeout wrapper
 */
const withTimeout = (promise, timeoutMs, timeoutMessage = 'Operation timed out') => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new AppError(timeoutMessage, 408)),
        timeoutMs
      )
    ),
  ]);
};

module.exports = {
  AppError,
  asyncHandler,
  errorHandler,
  voiceErrorFallback,
  retryWithBackoff,
  withTimeout,
};
