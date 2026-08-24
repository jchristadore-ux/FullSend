/**
 * Test bootstrap.
 *
 * Runs the whole product in-process: memory store, deterministic AI, mock
 * platform adapters. Nothing here reaches the network.
 */
import crypto from 'node:crypto';

process.env.FULLSEND_DB_DRIVER = 'memory';
process.env.FULLSEND_AI_PROVIDER = 'mock';
process.env.FULLSEND_LOG_SILENT = 'true';
process.env.FULLSEND_ENCRYPTION_KEY = crypto
  .createHash('sha256')
  .update('fullsend-test-key')
  .digest('base64');
process.env.CRON_SECRET = 'test-cron-secret';
process.env.NEXT_PUBLIC_APP_URL = 'https://fullsend.test';
process.env.FULLSEND_AI_MONTHLY_BUDGET_USD = '1000';
