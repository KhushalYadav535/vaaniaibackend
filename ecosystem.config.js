/**
 * PM2 Ecosystem Configuration
 * 
 * Usage:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.js
 *   pm2 start ecosystem.config.js --env production
 *   pm2 monit           # real-time monitoring
 *   pm2 logs            # view logs
 *   pm2 restart all     # restart all instances
 *   pm2 scale vaaniai +2  # add 2 more instances
 */
module.exports = {
  apps: [
    {
      name: 'vaaniai',
      script: 'server.js',
      instances: process.env.PM2_INSTANCES || 'max', // Use all CPU cores
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '500M',
      
      // Environment variables
      env: {
        NODE_ENV: 'development',
        PORT: 5000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000,
      },

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      
      // Restart policy
      autorestart: true,
      max_restarts: 10,
      restart_delay: 4000,
      
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 10000,
      
      // Health monitoring
      exp_backoff_restart_delay: 100,
    },
    {
      // Campaign worker as separate process (doesn't need clustering)
      name: 'vaaniai-campaigns',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        CAMPAIGN_WORKER_ONLY: 'true',
        PORT: 5001, // Different port to avoid conflict
      },
      max_memory_restart: '300M',
      autorestart: true,
    },
  ],
};
