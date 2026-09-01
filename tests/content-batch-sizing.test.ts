/**
 * How much a single content generation is allowed to ask for.
 *
 * This is a regression suite for a live failure. Content generation asked one
 * model call for six posts against a 9000-token ceiling, and the provider
 * client gives up after 40 seconds. Six real posts — a reel carries a
 * scene-by-scene plan, a narration script and up to twelve carousel slides —
 * do not come back in 40 seconds, so the run ended one of two ways: the SDK
 * abandoned it ("Anthropic API error: Request timed out."), or a partial
 * response arrived and the JSON stopped mid-object ("AI returned unusable
 * output: no JSON object found in the response"). Both were seen in production
 * on the same run. One cause, two faces.
 *
 * The numbers involved live in two files and neither knew about the other,
 * which is the actual defect: nothing failed when the batch size and the
 * timeout stopped being compatible. These tests are that missing link. They
 * fail at the old values and pass at the new ones.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, fakeGitHubClient, setupContext, teardown, type TestContext } from './helpers';
import {
  CONTENT_BATCH_SIZE,
  MAX_CONTENT_OUTPUT_TOKENS,
  PER_POST_TOKENS,
  TYPICAL_POST_TOKENS,
  contentMaxTokens,
  generateContent,
} from '@/lib/content/generate';
import { MAX_CONTENT_BATCHES } from '@/lib/jobs/runner';
import {
  MIN_PROVIDER_TIMEOUT_MS,
  estimatedGenerationMs,
} from '@/lib/ai/limits';
import { planSlots } from '@/lib/content/mix';
import { openSlots } from '@/lib/scheduler/schedule';
import { setProvider } from '@/lib/ai/client';
import { DeterministicProvider } from '@/lib/ai/deterministic-provider';
import { analyzeRepository } from '@/lib/analysis/analyze';
import { approveStrategy, buildStrategy, ensureBrandProfile } from '@/lib/strategy/build';
import type { AiProvider, CompletionRequest, CompletionResponse } from '@/lib/ai/types';
import type { Project } from '@/lib/types';

describe('a content batch against the provider timeout', () => {
  it('finishes inside the tightest timeout any provider imposes', () => {
    const outputTokens = CONTENT_BATCH_SIZE * TYPICAL_POST_TOKENS;
    expect(estimatedGenerationMs(outputTokens)).toBeLessThan(MIN_PROVIDER_TIMEOUT_MS);
  });

  it('would have rejected the batch size that failed in production', () => {
    // Six posts a batch: the value this suite exists to prevent coming back.
    expect(estimatedGenerationMs(6 * TYPICAL_POST_TOKENS)).toBeGreaterThan(MIN_PROVIDER_TIMEOUT_MS);
  });

  it('leaves a post room to be a rich one without being able to run long', () => {
    // The ceiling is per post and generous; the batch is what the clock sees.
    expect(PER_POST_TOKENS).toBeGreaterThan(TYPICAL_POST_TOKENS * 2);
    expect(MAX_CONTENT_OUTPUT_TOKENS).toBe(contentMaxTokens(CONTENT_BATCH_SIZE));
  });
});

describe('what content generation actually asks the model for', () => {
  let ctx: TestContext;
  let project: Project;

  beforeEach(async () => {
    ctx = await setupContext();
    project = await createProject(ctx.scope, ctx.user.id);
  });
  afterEach(() => teardown());

  /** Wraps the deterministic composer and records what it was asked for. */
  function recordingProvider(): { provider: AiProvider; calls: CompletionRequest[] } {
    const inner = new DeterministicProvider();
    const calls: CompletionRequest[] = [];
    const provider: AiProvider = {
      name: inner.name,
      live: false,
      modelFor: (tier) => inner.modelFor(tier),
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        calls.push(req);
        return inner.complete(req);
      },
    };
    return { provider, calls };
  }

  it('asks for one post and one post of tokens, however many slots are open', async () => {
    const analyzed = await analyzeRepository(ctx.scope, project, 'acme/taskflow', {
      client: fakeGitHubClient(),
    });
    const built = await buildStrategy(ctx.scope, project, analyzed.analysis);
    const { brand } = await ensureBrandProfile(ctx.scope, project, analyzed.analysis, built.strategy);
    const strategy = await approveStrategy(ctx.scope, built.strategy.id);

    // A full 90-day calendar: far more slots than one call may take on.
    const slots = await openSlots(ctx.scope, { project, strategy, days: 90, platforms: ['instagram'] });
    expect(slots.length).toBeGreaterThan(CONTENT_BATCH_SIZE);

    const { provider, calls } = recordingProvider();
    setProvider(provider);

    const result = await generateContent(ctx.scope, {
      project,
      analysis: analyzed.analysis,
      brand: brand!,
      strategy,
      personas: [],
      pillars: built.pillars,
      campaigns: built.campaigns,
      slots,
    });

    const batchCalls = calls.filter((c) => c.task === 'content.batch');
    expect(batchCalls.length).toBe(1);
    expect(batchCalls[0].maxTokens).toBe(MAX_CONTENT_OUTPUT_TOKENS);
    expect(batchCalls[0].maxTokens!).toBeLessThanOrEqual(MAX_CONTENT_OUTPUT_TOKENS);

    // The rest of the calendar is handed on rather than attempted here.
    expect(result.created.length + result.rejectedDuplicates).toBe(CONTENT_BATCH_SIZE);
    expect(result.remainingSlots).toBe(slots.length - CONTENT_BATCH_SIZE);
  });
});

describe('the chain that fills the rest of the calendar', () => {
  it('can reach the end of the largest calendar the product will accept', () => {
    // 90 days is the longest window /generate offers; 21 posts a week is the
    // fastest cadence the strategy schema permits; 10 a day is the cap ceiling.
    const slots = planSlots({
      days: 90,
      from: new Date('2026-01-05T08:00:00Z'),
      strategy: {
        content_mix: { education: 40, product_demo: 25, entertainment: 15, social_proof: 10, promotion: 10 },
        posting_cadence: { instagram_per_week: 21, tiktok_per_week: 0, best_times: [] },
        platform_strategy: [],
      },
      platforms: ['instagram'],
      dailyCap: 10,
    });

    expect(slots.length).toBeGreaterThan(0);
    expect(MAX_CONTENT_BATCHES * CONTENT_BATCH_SIZE).toBeGreaterThanOrEqual(slots.length);
  });
});
