const mongoose = require('mongoose');
const logger = require('../utils/logger');

// Surface connection lifecycle so a runtime Mongo drop is visible in logs
// instead of every request silently hanging. Mongoose buffers and retries
// internally; these listeners are observability + reconnect awareness.
mongoose.connection.on('connected', () => {
  logger.info('MongoDB connected');
});
mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected — driver will attempt to reconnect');
});
mongoose.connection.on('reconnected', () => {
  logger.info('MongoDB reconnected');
});
mongoose.connection.on('error', (err) => {
  logger.error('MongoDB connection error', { error: err.message });
});

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    logger.error('MONGODB_URI is not set. Add it to your .env file.');
    process.exit(1);
  }

  // Retry the INITIAL connection a few times before giving up. A container
  // that boots slightly before MongoDB shouldn't crash-loop instantly.
  const maxAttempts = Number(process.env.MONGO_CONNECT_RETRIES || 5);
  const retryDelayMs = Number(process.env.MONGO_CONNECT_RETRY_DELAY_MS || 3000);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const conn = await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5000,
      });
      logger.info(`MongoDB Connected: ${conn.connection.host}`);
      return;
    } catch (error) {
      logger.error(`MongoDB connection attempt ${attempt}/${maxAttempts} failed`, { error: error.message });
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      } else {
        logger.error('Exhausted MongoDB connection attempts. Check MONGODB_URI / that MongoDB is running.');
        process.exit(1);
      }
    }
  }
};

module.exports = connectDB;
