/**
 * `server-only` shim for Node scripts.
 *
 * The real package throws unless it is loaded by a Next.js server bundle. The
 * CLI scripts (e2e, worker, seed) genuinely are server-side, so the guard has
 * nothing to protect against there. Only tsconfig.scripts.json maps to this —
 * the app build keeps the real guard.
 */
export {};
