/**
 * Environment defaults for CLI scripts.
 *
 * Imported first — before any module that reads `process.env` at load time.
 * ESM hoists imports above statements, so these assignments cannot live in the
 * script itself.
 */
import crypto from 'node:crypto';

process.env.FULLSEND_DB_DRIVER ??= 'memory';
process.env.FULLSEND_AI_PROVIDER ??= 'mock';
process.env.FULLSEND_LOG_SILENT ??= 'true';
process.env.NEXT_PUBLIC_APP_URL ??= 'http://localhost:3000';
process.env.FULLSEND_AI_MONTHLY_BUDGET_USD ??= '1000';
process.env.FULLSEND_ENCRYPTION_KEY ??= crypto
  .createHash('sha256')
  .update('fullsend-local-script-key')
  .digest('base64');

export {};
