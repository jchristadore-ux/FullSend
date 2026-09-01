import { env } from '../env';
import { MemoryStore } from './memory-store';
import type { Store } from './store';

/**
 * The store is pinned to `globalThis` rather than a module-level variable.
 *
 * Next.js loads route handlers and server components as separate module
 * instances in development, which would otherwise give each of them its own
 * MemoryStore — sign in through an API route and the page rendering the
 * dashboard would see no session. The same pin also survives hot reloads.
 */
const KEY = Symbol.for('fullsend.store');

interface GlobalWithStore {
  [KEY]?: Store | null;
}

const globalRef = globalThis as unknown as GlobalWithStore;

/** Process-wide store. Driver comes from FULLSEND_DB_DRIVER. */
export function getStore(): Store {
  const existing = globalRef[KEY];
  if (existing) return existing;

  let instance: Store;
  if (env.dbDriver === 'supabase') {
    // Required lazily so the memory driver never pulls in the Supabase client.
    const { SupabaseStore } = require('./supabase-store') as typeof import('./supabase-store');
    instance = new SupabaseStore();
  } else {
    instance = new MemoryStore();
  }
  globalRef[KEY] = instance;
  return instance;
}

/** Test seam. */
export function setStore(store: Store | null): void {
  globalRef[KEY] = store;
}

export * from './store';
export { MemoryStore } from './memory-store';
