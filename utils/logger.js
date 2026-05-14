/**
 * Structured Logger using Winston
 * Replaces raw console.log with proper log levels, timestamps, and file rotation.
 * 
 * Usage:
 *   const logger = require('./utils/logger');
 *   logger.info('Server started', { port: 5000 });
 *   logger.warn('Rate limit hit', { userId: '...' });
 *   logger.error('DB connection failed', { error: err.message });
 * 
 * Levels: error, warn, info, http, debug
 * Output: Console (colorized) + logs/app.log + logs/error.log
 */

const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

let winston;
try {
  winston = require('winston');
} catch {
  // Winston not installed — fallback to enhanced console logger
  const levels = { error: 0, warn: 1, info: 2, http: 3, debug: 4 };
  const currentLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
  const currentLevelNum = levels[currentLevel] || 2;

  const fallback = {};
  for (const [level, num] of Object.entries(levels)) {
    fallback[level] = (message, meta = {}) => {
      if (num > currentLevelNum) return;
      const ts = new Date().toISOString();
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      const prefix = `[${ts}] [${level.toUpperCase()}]`;
      if (level === 'error') console.error(`${prefix} ${message}${metaStr}`);
      else if (level === 'warn') console.warn(`${prefix} ${message}${metaStr}`);
      else console.log(`${prefix} ${message}${metaStr}`);
    };
  }
  fallback.stream = { write: (msg) => fallback.http(msg.trim()) };
  module.exports = fallback;
  return; // skip Winston setup
}

const { createLogger, format, transports } = winston;
const { combine, timestamp, printf, colorize, errors, json } = format;

// Custom format for console
const consoleFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `[${timestamp}] [${level}] ${message}${metaStr}`;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
  ),
  defaultMeta: { service: 'vaaniai-backend' },
  transports: [
    // Console (always)
    new transports.Console({
      format: combine(colorize(), consoleFormat),
    }),

    // Combined log file
    new transports.File({
      filename: path.join(logDir, 'app.log'),
      format: combine(json()),
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
    }),

    // Error-only log file
    new transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      format: combine(json()),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

// Stream for Morgan HTTP logging
logger.stream = { write: (message) => logger.http(message.trim()) };

module.exports = logger;
