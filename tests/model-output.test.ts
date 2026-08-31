/**
 * Reading what the model actually sent.
 *
 * The failure these cover is the one founders saw on the home screen:
 * "AI returned unusable output: confidence: Invalid input: expected number,
 * received string". The analysis step rejected the whole product analysis
 * because one honest score came back as a word, and with no analysis there was
 * no strategy, no calendar, and nothing queued.
 *
 * Two things had to hold to fix it and both are pinned here: the model is told
 * the exact shape, and a notation mistake in the reply is repaired rather than
 * thrown away — without ever loosening what reaches the database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateObject, setProvider } from '@/lib/ai/client';
import { coerceToSchema } from '@/lib/ai/coerce';
import { jsonSchemaFor } from '@/lib/ai/json-schema';
import { clearCache } from '@/lib/ai/cache';
import { FullSendError } from '@/lib/errors';
import { contentBatchSchema, productAnalysisSchema, recommendationsSchema } from '@/lib/schemas';
import type { AiProvider, CompletionRequest, CompletionResponse } from '@/lib/ai/types';
import { freshStore, teardown } from './helpers';

/** A provider that says exactly what a test wants it to say. */
class ScriptedProvider implements AiProvider {
  readonly name = 'scripted';
  readonly live = true;
  readonly requests: CompletionRequest[] = [];

  constructor(private replies: string[]) {}

  modelFor(): string {
    return 'scripted-model';
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(req);
    const text = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)];
    return {
      text,
      model: 'scripted-model',
      provider: this.name,
      usage: { inputTokens: 100, outputTokens: 100, cachedInputTokens: 0 },
      costUsd: 0.001,
      cacheHit: false,
    };
  }
}

/** A complete, valid analysis except for whatever a test overrides. */
function analysisReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    one_liner: 'Ships marketing for solo app founders',
    what_it_does: 'Reads a repository and runs the marketing for the product it finds.',
    category: 'marketing automation',
    features: [
      { name: 'Calendar', description: 'Schedules posts', evidence: ['src/app/app/calendar'] },
    ],
    not_capabilities: ['Does not run paid ads'],
    tech_stack: ['next', 'supabase'],
    platforms: ['instagram'],
    target_market: 'Solo founders',
    problem_solved: 'Marketing does not happen',
    differentiators: ['Runs itself'],
    maturity: 'beta',
    confidence: 0.6,
    ...overrides,
  });
}

const analysisShape = jsonSchemaFor(productAnalysisSchema);

describe('telling the model the shape', () => {
  it('derives a JSON schema from the validator itself', () => {
    const shape = analysisShape as Record<string, any>;
    expect(shape.type).toBe('object');
    expect(shape.properties.confidence).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
    expect(shape.properties.maturity.enum).toContain('production');
    // The dialect line is noise in a prompt.
    expect(shape.$schema).toBeUndefined();
  });

  it('describes what to send, so a defaulted field is not demanded', () => {
    const shape = jsonSchemaFor(productAnalysisSchema) as Record<string, any>;
    expect(shape.required).toContain('one_liner');
    expect(shape.required ?? []).not.toContain('confidence');
  });

  it('reuses the derivation rather than rebuilding it per call', () => {
    expect(jsonSchemaFor(productAnalysisSchema)).toBe(jsonSchemaFor(productAnalysisSchema));
  });

  it('covers every schema a generation step validates against', () => {
    for (const schema of [productAnalysisSchema, recommendationsSchema, contentBatchSchema]) {
      expect(jsonSchemaFor(schema)).not.toBeNull();
    }
  });
});

describe('repairing notation mistakes', () => {
  const coerce = (raw: unknown) => coerceToSchema(raw, analysisShape) as Record<string, any>;

  it('reads a score written as a word', () => {
    expect(coerce({ confidence: 'high' }).confidence).toBeCloseTo(0.8);
    expect(coerce({ confidence: 'low' }).confidence).toBeCloseTo(0.25);
    expect(coerce({ confidence: 'Very High' }).confidence).toBeCloseTo(0.9);
    expect(coerce({ confidence: 'medium' }).confidence).toBeCloseTo(0.5);
  });

  it('reads a score written as a number in a string', () => {
    expect(coerce({ confidence: '0.4' }).confidence).toBe(0.4);
    expect(coerce({ confidence: ' 0.75 ' }).confidence).toBe(0.75);
  });

  it('reads a fraction offered as a percentage or a ratio', () => {
    expect(coerce({ confidence: '85%' }).confidence).toBeCloseTo(0.85);
    expect(coerce({ confidence: 85 }).confidence).toBeCloseTo(0.85);
    expect(coerce({ confidence: '8/10' }).confidence).toBeCloseTo(0.8);
  });

  it('leaves a score it cannot read for validation to reject', () => {
    expect(coerce({ confidence: 'depends on the repo' }).confidence).toBe('depends on the repo');
    expect(productAnalysisSchema.safeParse(coerce({ confidence: 'depends' })).success).toBe(false);
  });

  it('matches an enum through casing and separators', () => {
    expect(coerce({ maturity: 'Production' }).maturity).toBe('production');
    expect(coerce({ maturity: 'nearly there' }).maturity).toBe('nearly there');
  });

  it('converts descriptive objects to strings when the schema requires strings', () => {
    const out = coerce({
      not_capabilities: [
        { capability: 'Paid ads', reason: 'No ad-buying integration exists' },
        { name: 'Email marketing', description: 'No email sender is implemented' },
      ],
    });
    expect(out.not_capabilities).toEqual([
      'Paid ads: No ad-buying integration exists',
      'Email marketing: No email sender is implemented',
    ]);
  });

  it('wraps a lone value where a list was wanted', () => {
    expect(coerce({ tech_stack: 'next' }).tech_stack).toEqual(['next']);
    expect(coerce({ tech_stack: ['next'] }).tech_stack).toEqual(['next']);
  });

  it('repairs inside nested items, not just at the top level', () => {
    const out = coerce({
      features: [{ name: 'Calendar', user_facing: 'yes', evidence: 'src/app' }],
    });
    expect(out.features[0].user_facing).toBe(true);
    expect(out.features[0].evidence).toEqual(['src/app']);
  });

  it('lets a default stand in for an explicit null', () => {
    const out = productAnalysisSchema.safeParse(
      JSON.parse(analysisReply({ tech_stack: null, confidence: null })),
    );
    expect(out.success).toBe(false);

    const nulled = JSON.parse(analysisReply({ tech_stack: null, confidence: null }));
    const repaired = productAnalysisSchema.parse(coerceToSchema(nulled, analysisShape));
    expect(repaired.tech_stack).toEqual([]);
    expect(repaired.confidence).toBe(0.5);
  });

  it('keeps a genuine null where the schema allows one', () => {
    const shape = jsonSchemaFor(contentBatchSchema);
    const raw = {
      items: [
        {
          platform: 'TikTok',
          format: 'reel',
          pillar_type: 'Product Demo',
          hook: 'Watch this',
          caption: 'A caption',
          script: null,
        },
      ],
    };
    const parsed = contentBatchSchema.parse(coerceToSchema(raw, shape));
    expect(parsed.items[0].platform).toBe('tiktok');
    expect(parsed.items[0].pillar_type).toBe('product_demo');
    expect(parsed.items[0].script).toBeNull();
  });

  it('follows the right arm of a discriminated union', () => {
    const shape = jsonSchemaFor(recommendationsSchema);
    const raw = {
      recommendations: [
        {
          statement: 'Move budget into reels',
          action: { type: 'increase_format', platform: 'Instagram', format: 'reel', per_week: '5' },
          confidence: 'high',
        },
      ],
    };
    const parsed = recommendationsSchema.parse(coerceToSchema(raw, shape));
    expect(parsed.recommendations[0].action).toMatchObject({ platform: 'instagram', per_week: 5 });
    expect(parsed.recommendations[0].confidence).toBeCloseTo(0.8);
  });

  it('does nothing at all without a schema to read', () => {
    const raw = { confidence: 'high' };
    expect(coerceToSchema(raw, null)).toBe(raw);
  });
});

describe('generating against a real reply', () => {
  beforeEach(() => {
    freshStore();
    clearCache();
  });

  afterEach(() => {
    teardown();
    clearCache();
  });

  const options = {
    task: 'analysis.product',
    system: 'You are FullSend’s product analyst.',
    brief: 'Work out what this is.',
    context: {},
    schema: productAnalysisSchema,
  };

  it('sends the model the shape it will be held to', async () => {
    const provider = new ScriptedProvider([analysisReply()]);
    setProvider(provider);

    await generateObject({ ...options, noCache: true });

    expect(provider.requests[0].jsonSchema).toMatchObject({ type: 'object' });
  });

  it('accepts the reply that used to fail the whole run', async () => {
    const provider = new ScriptedProvider([analysisReply({ confidence: 'high' })]);
    setProvider(provider);

    const { data } = await generateObject({ ...options, noCache: true });

    expect(data.confidence).toBeCloseTo(0.8);
    // Repaired in place: no second call, so no second bill.
    expect(provider.requests).toHaveLength(1);
  });

  it('still refuses output that is wrong rather than merely mistyped', async () => {
    setProvider(new ScriptedProvider([analysisReply({ one_liner: 'no' })]));

    await expect(generateObject({ ...options, noCache: true })).rejects.toThrow(FullSendError);
  });

  it('never echoes an empty turn back to the provider', async () => {
    const provider = new ScriptedProvider(['', analysisReply()]);
    setProvider(provider);

    const { data } = await generateObject({ ...options, noCache: true });

    expect(data.one_liner).toBeTruthy();
    expect(provider.requests).toHaveLength(2);
    for (const message of provider.requests[1].messages) {
      expect(message.content.trim()).not.toBe('');
    }
    expect(provider.requests[1].messages.map((m) => m.role)).toEqual(['user']);
  });

  it('echoes a salvageable attempt so the model can correct it', async () => {
    const provider = new ScriptedProvider(['{"one_liner": 42}', analysisReply()]);
    setProvider(provider);

    await generateObject({ ...options, noCache: true });

    const roles = provider.requests[1].messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'user']);
  });

  it('keeps a schema that will not convert from breaking generation', async () => {
    const awkward = z.custom<{ ok: boolean }>((v) => typeof v === 'object' && v !== null);
    expect(() => jsonSchemaFor(awkward)).not.toThrow();

    setProvider(new ScriptedProvider(['{"ok": true}']));
    const { data } = await generateObject({
      ...options,
      schema: awkward,
      noCache: true,
    });
    expect(data).toEqual({ ok: true });
  });
});

/**
 * Fitting inside the invocation that holds it.
 *
 * A serverless function is killed at sixty seconds. A model call allowed two
 * minutes, or two calls of forty seconds each, outlives the function every
 * time — and a killed function writes nothing down, which is why a failing
 * stage reported "cut off part-way" with nothing after it.
 */
describe('staying inside the time it has', () => {
  beforeEach(() => {
    freshStore();
    clearCache();
  });

  afterEach(() => {
    teardown();
    clearCache();
  });

  const options = {
    task: 'analysis.product',
    system: 'You are FullSend’s product analyst.',
    brief: 'Work out what this is.',
    context: {},
    schema: productAnalysisSchema,
  };

  it('does not spend a second call it does not have time for', async () => {
    /** Answers badly, and slowly enough that a repair turn would not fit. */
    const slow: AiProvider = {
      name: 'slow',
      live: true,
      modelFor: () => 'slow-model',
      complete: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return {
          text: '{"one_liner": 42}',
          model: 'slow-model',
          provider: 'slow',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          costUsd: 0,
          cacheHit: false,
        };
      },
    };

    let calls = 0;
    setProvider({
      ...slow,
      complete: async (req) => {
        calls++;
        return slow.complete(req);
      },
    });

    // With the clock past the point where a repair turn fits, the queue is
    // handed the failure rather than a second call inside a dying function.
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(60_000);

    await expect(generateObject({ ...options, noCache: true })).rejects.toThrow(
      /unusable output/,
    );
    expect(calls).toBe(1);
    vi.restoreAllMocks();
  });

  it('still repairs in place when there is time', async () => {
    const provider = new ScriptedProvider(['{"one_liner": 42}', analysisReply()]);
    setProvider(provider);

    const { data } = await generateObject({ ...options, noCache: true });

    expect(data.one_liner).toBeTruthy();
    expect(provider.requests).toHaveLength(2);
  });
});
