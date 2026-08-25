/**
 * Provider selection.
 *
 * Every other test runs on the deterministic provider, so the branches that
 * construct a real vendor adapter had never executed anywhere but a deployment
 * with an API key in it — which is the first thing a founder adds, and the
 * first thing that then broke.
 *
 * These assert only that each setting yields a constructed provider of the
 * right name. Constructing one must not reach the network: the vendor client
 * is built on first use, not in the constructor, and that is part of what is
 * being pinned here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL = process.env.FULLSEND_AI_PROVIDER;

/** Re-imports the module graph so `env` picks up the provider setting. */
async function providerFor(setting: string) {
  process.env.FULLSEND_AI_PROVIDER = setting;
  vi.resetModules();
  const { getProvider, setProvider } = await import('@/lib/ai/client');
  setProvider(null);
  return getProvider();
}

describe('choosing an AI provider', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    if (ORIGINAL === undefined) delete process.env.FULLSEND_AI_PROVIDER;
    else process.env.FULLSEND_AI_PROVIDER = ORIGINAL;
    vi.resetModules();
    const { setProvider } = await import('@/lib/ai/client');
    setProvider(null);
  });

  it('constructs the Anthropic adapter', async () => {
    const p = await providerFor('anthropic');
    expect(p.name).toBe('anthropic');
    expect(typeof p.complete).toBe('function');
  });

  it('constructs the OpenAI adapter', async () => {
    const p = await providerFor('openai');
    expect(p.name).toBe('openai');
    expect(typeof p.complete).toBe('function');
  });

  it('falls back to the deterministic composer', async () => {
    const p = await providerFor('mock');
    expect(p.name).toBe('deterministic');
    expect(typeof p.complete).toBe('function');
  });

  it('names a model for every tier, whichever provider is active', async () => {
    for (const setting of ['anthropic', 'openai', 'mock']) {
      const p = await providerFor(setting);
      for (const tier of ['fast', 'standard', 'premium'] as const) {
        expect(p.modelFor(tier)).toBeTruthy();
      }
    }
  });
});
