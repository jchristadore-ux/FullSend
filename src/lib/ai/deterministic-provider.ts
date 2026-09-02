/**
 * Deterministic provider.
 *
 * Not a stub and not a placeholder generator: it composes real output from the
 * structured context it is handed — actual repo features, actual persona pain
 * points, actual performance numbers. Output is usable content, just written by
 * rules instead of a language model.
 *
 * It exists for three reasons: the test suite needs hermetic, repeatable
 * generation; the product must run end-to-end before anyone has provisioned an
 * API key; and a provider outage should degrade the machine, not stop it.
 * Everywhere it is in use, the UI reports the AI provider as `deterministic`
 * rather than implying a model wrote the copy.
 */

import { sha256 } from '../ids';
import type { ContentFormat, PillarType, Platform } from '../types';
import { estimateTokens } from './pricing';
import type { AiProvider, CompletionRequest, CompletionResponse, ModelTier } from './types';

type Ctx = Record<string, any>;

export class DeterministicProvider implements AiProvider {
  readonly name = 'deterministic';
  readonly live = false;

  modelFor(tier: ModelTier): string {
    return `deterministic-${tier}`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const payload = safeParse(req.messages[req.messages.length - 1]?.content ?? '{}');
    const context: Ctx = payload?.context ?? {};
    const text = JSON.stringify(compose(req.task, context, req.system));
    return {
      text,
      model: this.modelFor(req.tier),
      provider: this.name,
      usage: {
        inputTokens: estimateTokens(req.system + JSON.stringify(context)),
        outputTokens: estimateTokens(text),
        cachedInputTokens: 0,
      },
      // Composed locally, so it genuinely costs nothing.
      costUsd: 0,
      cacheHit: false,
    };
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Stable pseudo-random in [0,1) derived from a seed — keeps output repeatable. */
function rand(seed: string): number {
  const h = sha256(seed);
  return parseInt(h.slice(0, 8), 16) / 0xffffffff;
}

function pick<T>(arr: T[], seed: string): T {
  return arr[Math.floor(rand(seed) * arr.length) % arr.length];
}

/** Compares hooks the way a reader would: wording, not punctuation or case. */
function normalizeHook(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function compose(task: string, ctx: Ctx, system: string): unknown {
  switch (task) {
    case 'analysis.product':
      return composeAnalysis(ctx);
    case 'analysis.personas':
      return composePersonas(ctx);
    case 'strategy.build':
      return composeStrategy(ctx);
    case 'brand.profile':
      return composeBrand(ctx, system);
    case 'content.batch':
      return composeContentBatch(ctx);
    case 'optimizer.recommendations':
      return composeRecommendations(ctx);
    case 'report.weekly':
      return composeWeeklyInsight(ctx);
    case 'trends.scan':
      return { signals: [] };
    default:
      return {};
  }
}

/* ── Product analysis ───────────────────────────────────────────────────── */

function composeAnalysis(ctx: Ctx): unknown {
  const repo = ctx.repository ?? {};
  const signals = ctx.signals ?? {};
  const name: string = titleCase(repo.name ?? 'the product');
  const description: string = repo.description ?? '';
  const readmeSummary: string = (signals.readme_summary ?? '').slice(0, 1200);
  const deps: string[] = signals.dependencies ?? [];
  const routes: string[] = signals.routes ?? [];
  const scripts: string[] = signals.scripts ?? [];
  const topics: string[] = repo.topics ?? [];

  const stack = inferStack(deps, signals.languages ?? {});
  const category = inferCategory(topics, deps, description, readmeSummary);
  const platforms = inferPlatforms(deps, scripts);

  /*
   * Features come from README headings and routes — real evidence, not
   * invention. README headings lead because they are how the author describes
   * the product ("Automatic task extraction"), while a route often yields a
   * bare noun ("digest") that makes for thin marketing copy.
   */
  const featureSources: { label: string; evidence: string }[] = [
    ...(signals.readme_headings ?? [])
      .slice(0, 6)
      .map((h: string) => ({ label: h, evidence: 'README' })),
    ...routes.slice(0, 8).map((r: string) => ({ label: routeToFeature(r), evidence: r })),
  ];

  // Plumbing screens nobody markets.
  const BORING = /^(settings|login|signup|sign-?in|auth|admin|account|profile|privacy|terms|404|error|callback)$/i;

  const seen = new Set<string>();
  const features = featureSources
    .filter((f) => {
      const k = f.label.toLowerCase().trim();
      if (!k || seen.has(k) || BORING.test(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8)
    .map((f) => ({
      name: titleCase(f.label),
      description: `${titleCase(f.label)} in ${name}.`,
      evidence: [f.evidence],
      user_facing: !/api|internal|admin|webhook|cron/i.test(f.label),
    }));

  const oneLiner =
    description ||
    (readmeSummary.split(/[.\n]/)[0] ?? '').trim() ||
    `${name} — a ${category.toLowerCase()} built with ${stack.slice(0, 2).join(' and ') || 'modern tooling'}.`;

  return {
    one_liner: oneLiner.slice(0, 200),
    what_it_does:
      readmeSummary.slice(0, 600) ||
      `${name} is a ${category.toLowerCase()}. ${features.length ? `It covers ${features.slice(0, 3).map((f) => f.name.toLowerCase()).join(', ')}.` : ''}`.trim(),
    category,
    features,
    // Claims outside the verified feature list are explicitly out of bounds.
    not_capabilities: [
      'Anything not evidenced in the repository at analysis time',
      'Performance, revenue or user-count claims',
      'Integrations not present in the dependency list',
    ],
    tech_stack: stack,
    platforms,
    target_market: inferMarket(category, topics),
    problem_solved:
      readmeSummary.match(/(?:problem|why|instead of)[^.]{10,200}\./i)?.[0]?.trim() ||
      problemFor(category, features.map((f) => f.name)),
    differentiators: buildDifferentiators(name, stack, features.map((f) => f.name), topics),
    maturity: inferMaturity(signals),
    confidence: Math.min(
      0.92,
      0.35 + features.length * 0.06 + (readmeSummary ? 0.2 : 0) + (description ? 0.1 : 0),
    ),
  };
}

function routeToFeature(route: string): string {
  const parts = route
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((p) => p && !p.startsWith('[') && !p.startsWith(':') && p !== 'api');
  return parts[parts.length - 1] ?? parts[0] ?? '';
}

function inferStack(deps: string[], languages: Record<string, number>): string[] {
  const out = new Set<string>();
  const map: [RegExp, string][] = [
    [/^next$/, 'Next.js'],
    [/^react$/, 'React'],
    [/^vue$/, 'Vue'],
    [/^svelte/, 'Svelte'],
    [/^@angular/, 'Angular'],
    [/^express$/, 'Express'],
    [/^fastify$/, 'Fastify'],
    [/^tailwindcss$/, 'Tailwind CSS'],
    [/^typescript$/, 'TypeScript'],
    [/^prisma|@prisma/, 'Prisma'],
    [/^drizzle/, 'Drizzle'],
    [/supabase/, 'Supabase'],
    [/^stripe$/, 'Stripe'],
    [/^django$/, 'Django'],
    [/^flask$/, 'Flask'],
    [/^fastapi$/, 'FastAPI'],
    [/^rails$/, 'Rails'],
    [/^react-native|expo/, 'React Native'],
    [/^electron$/, 'Electron'],
    [/^socket\.io|^ws$/, 'WebSockets'],
    [/openai|@anthropic-ai/, 'AI APIs'],
  ];
  for (const d of deps) for (const [re, label] of map) if (re.test(d)) out.add(label);
  for (const lang of Object.keys(languages).slice(0, 3)) out.add(lang);
  return [...out].slice(0, 10);
}

function inferCategory(
  topics: string[],
  deps: string[],
  description: string,
  readme: string,
): string {
  const hay = `${topics.join(' ')} ${description} ${readme}`.toLowerCase();
  const rules: [RegExp, string][] = [
    [/\b(ai|llm|gpt|agent|model)\b/, 'AI tool'],
    [/\b(saas|dashboard|analytics)\b/, 'SaaS product'],
    [/\b(cli|command.?line|terminal)\b/, 'Developer CLI'],
    [/\b(mobile|ios|android)\b/, 'Mobile app'],
    [/\b(game|gaming)\b/, 'Game'],
    [/\b(ecommerce|shop|store|checkout)\b/, 'E-commerce product'],
    [/\b(fitness|health|workout|habit)\b/, 'Health & fitness app'],
    [/\b(finance|budget|invoice|accounting)\b/, 'Finance tool'],
    [/\b(design|editor|canvas)\b/, 'Design tool'],
    [/\b(productivity|todo|task|note)\b/, 'Productivity app'],
    [/\b(api|sdk|library|framework)\b/, 'Developer tool'],
  ];
  for (const [re, label] of rules) if (re.test(hay)) return label;
  if (deps.some((d) => /^next$|^react$/.test(d))) return 'Web app';
  return 'Software product';
}

function inferPlatforms(deps: string[], scripts: string[]): string[] {
  const out = new Set<string>();
  if (deps.some((d) => /^next$|^react$|^vue$|^svelte/.test(d))) out.add('Web');
  if (deps.some((d) => /react-native|expo/.test(d))) out.add('iOS');
  if (deps.some((d) => /react-native|expo/.test(d))) out.add('Android');
  if (deps.some((d) => /^electron$/.test(d))) out.add('Desktop');
  if (scripts.some((s) => /cli|bin/.test(s))) out.add('CLI');
  if (out.size === 0) out.add('Web');
  return [...out];
}

/** A real problem statement, phrased around what the product does. */
function problemFor(category: string, features: string[]): string {
  const feature = features[0]?.toLowerCase();
  if (feature) {
    return `${sentence(feature)} by hand takes longer than it should, and it is easy to get wrong.`;
  }
  if (/developer|cli|api/i.test(category)) {
    return 'The setup work has to be repeated on every project, by hand, every time.';
  }
  if (/saas|analytics|finance/i.test(category)) {
    return 'The work lives across several tools and none of them talk to each other.';
  }
  return 'It is the kind of task people put off, then do badly under time pressure.';
}

/** Capitalises the first letter without touching the rest. */
function sentence(s: string): string {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Lowercases the first letter unless the word is an acronym. */
function lowerFirst(s: string): string {
  const t = s.trim();
  if (/^[A-Z]{2,}/.test(t)) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function inferMarket(category: string, topics: string[]): string {
  if (/developer|cli/i.test(category)) return 'Developers and technical teams';
  if (/saas|analytics/i.test(category)) return 'Small teams and operators who live in dashboards';
  if (/mobile|fitness|productivity/i.test(category)) return 'Individual consumers on their phones';
  if (topics.length) return `People working on ${topics.slice(0, 2).join(' and ')}`;
  return 'Early adopters who feel this problem weekly';
}

function inferMaturity(signals: Ctx): 'prototype' | 'alpha' | 'beta' | 'production' {
  const files = signals.file_count ?? 0;
  const hasTests = Boolean(signals.has_tests);
  const hasCi = Boolean(signals.has_ci);
  if (hasTests && hasCi && files > 60) return 'production';
  if (hasTests && files > 25) return 'beta';
  if (files > 12) return 'alpha';
  return 'prototype';
}

function buildDifferentiators(
  name: string,
  stack: string[],
  features: string[],
  topics: string[],
): string[] {
  const out: string[] = [];
  if (features.length >= 3) {
    out.push(`${name} covers ${features.slice(0, 3).join(', ').toLowerCase()} in one place`);
  }
  if (stack.includes('AI APIs')) out.push('The work happens automatically instead of manually');
  if (topics.length) out.push(`Purpose-built for ${topics[0]} rather than generic`);
  out.push('Built by someone who actually has this problem');
  return out.slice(0, 4);
}

/* ── Personas ───────────────────────────────────────────────────────────── */

function composePersonas(ctx: Ctx): unknown {
  const a = ctx.analysis ?? {};
  const category: string = a.category ?? 'Software product';
  const features: string[] = (a.features ?? []).map((f: any) => f.name);
  const problem: string = a.problem_solved ?? 'a slow manual process';

  const archetypes = personaArchetypes(category);
  return {
    personas: archetypes.map((arch, i) => ({
      name: arch.name,
      role: arch.role,
      description: `${arch.role} who ${arch.context}. ${
        features.length ? `Would use ${features[0]?.toLowerCase() ?? 'the core feature'} first.` : ''
      }`.trim(),
      pain_points: [problem, ...arch.pains].slice(0, 4),
      goals: arch.goals,
      objections: arch.objections,
      where_they_hang_out: arch.platforms,
      tone_preference: arch.tone,
      priority: i + 1,
    })),
  };
}

function personaArchetypes(category: string) {
  const dev = {
    name: 'Sam the Shipper',
    role: 'Solo developer / indie hacker',
    context: 'ships side projects at night and hates repetitive setup',
    pains: ['Too many tools to wire together', 'No time for the boring parts'],
    goals: ['Ship faster', 'Spend time on the interesting problem'],
    objections: ['Is this just a wrapper?', 'Will it lock me in?'],
    platforms: ['tiktok', 'instagram'] as Platform[],
    tone: 'Direct, technical, no fluff',
  };
  const operator = {
    name: 'Priya the Operator',
    role: 'Ops / marketing lead at a small team',
    context: 'runs six tools and still does the work by hand',
    pains: ['Manual work eats the week', 'Nothing talks to anything else'],
    goals: ['Cut the busywork', 'Show results to the team'],
    objections: ['How long until it pays off?', 'Do I have to change my process?'],
    platforms: ['instagram', 'tiktok'] as Platform[],
    tone: 'Practical, outcome-first',
  };
  const consumer = {
    name: 'Jordan the Everyday User',
    role: 'Busy consumer',
    context: 'tried three apps for this and abandoned all of them',
    pains: ['Apps that take more effort than they save', 'Losing momentum after a week'],
    goals: ['See a result in the first minute', 'Actually stick with it'],
    objections: ['Another subscription?', 'Will I actually use it?'],
    platforms: ['tiktok', 'instagram'] as Platform[],
    tone: 'Warm, plain language, quick payoff',
  };
  const founder = {
    name: 'Alex the Founder',
    role: 'Early-stage founder',
    context: 'is wearing every hat and running out of hours',
    pains: ['Doing five jobs badly instead of one well', 'No time to do this properly'],
    goals: ['Get the busywork off the list', 'Spend the day on the real problem'],
    objections: ['Is it worth the setup time?', 'Will it actually stick?'],
    platforms: ['instagram', 'tiktok'] as Platform[],
    tone: 'Bold, peer-to-peer, ambitious',
  };

  if (/developer|cli|api/i.test(category)) return [dev, founder, operator];
  if (/saas|analytics|finance/i.test(category)) return [operator, founder, dev];
  if (/mobile|fitness|productivity|game/i.test(category)) return [consumer, founder, operator];
  return [founder, operator, consumer];
}

/* ── Strategy ───────────────────────────────────────────────────────────── */

function composeStrategy(ctx: Ctx): unknown {
  const a = ctx.analysis ?? {};
  const personas: any[] = ctx.personas ?? [];
  const name: string = ctx.project_name ?? titleCase(a.category ?? 'the product');
  const features: string[] = (a.features ?? []).map((f: any) => f.name);
  const painPoints: string[] = personas.flatMap((p) => p.pain_points ?? []).slice(0, 5);

  return {
    // The problem is a full sentence, so it gets its own clause rather than
    // being spliced in after "tired of".
    positioning:
      `${name} is the ${a.category ?? 'tool'} for ${lowerFirst(a.target_market ?? 'people with this problem')}. ` +
      `${sentence(a.problem_solved ?? 'Doing it by hand takes longer than it should.')}`,
    value_proposition: a.one_liner ?? `${name} does the work you keep putting off.`,
    audience_summary:
      personas.map((p) => `${p.name} (${p.role})`).join('; ') ||
      (a.target_market ?? 'Early adopters'),
    pain_points: painPoints.length ? painPoints : [a.problem_solved ?? 'Manual, repetitive work'],
    differentiators: a.differentiators ?? [],
    campaign_strategy:
      'Lead with the problem, prove it with the real product on screen, then convert with a ' +
      'single clear next step. Education builds the top of funnel, demos do the convincing.',
    posting_cadence: {
      instagram_per_week: 4,
      tiktok_per_week: 5,
      best_times: [
        { day: 1, hour: 9, platform: 'instagram' },
        { day: 2, hour: 18, platform: 'tiktok' },
        { day: 3, hour: 9, platform: 'instagram' },
        { day: 4, hour: 19, platform: 'tiktok' },
        { day: 5, hour: 12, platform: 'instagram' },
      ],
    },
    platform_strategy: [
      {
        platform: 'instagram',
        rationale: 'Carousels teach and get saved; Reels reach past the existing following.',
        formats: ['reel', 'carousel', 'static'],
        weight: 45,
      },
      {
        platform: 'tiktok',
        rationale: 'Highest reach per post for an unknown product, and demo content performs.',
        formats: ['short_video'],
        weight: 55,
      },
    ],
    growth_strategy:
      'Post consistently for four weeks, double down on whatever format wins, and turn the ' +
      'best-performing hooks into a repeatable series.',
    cta_strategy: [
      'Link in bio',
      'Comment a keyword for the link',
      'Save this for when you need it',
      'Follow for the build',
    ],
    content_mix: {
      education: 40,
      product_demo: 25,
      entertainment: 15,
      social_proof: 10,
      promotion: 10,
    },
    pillars: [
      {
        name: 'How it actually works',
        type: 'education',
        description: `Teach the thing ${name} does, whether or not they ever sign up.`,
        example_topics: features.slice(0, 3).map((f) => `How to ${f.toLowerCase()} in 10 seconds`),
      },
      {
        name: 'Watch it do the thing',
        type: 'product_demo',
        description: 'Real screens, real workflow, no mockups.',
        example_topics: features.slice(0, 3).map((f) => `${f}, start to finish`),
      },
      {
        name: 'Founder POV',
        type: 'entertainment',
        description: 'The build, the frustration, the small wins.',
        // Topic-shaped, not hook-shaped: these get slotted into hook templates.
        example_topics: ['the manual workflow', 'why this exists', 'the build'],
      },
      {
        name: 'Proof',
        type: 'social_proof',
        description: 'What people say, what changed for them.',
        example_topics: ['the first week', 'what users asked for', 'real results'],
      },
      {
        name: 'The ask',
        type: 'promotion',
        description: 'Direct, occasional, never the majority.',
        example_topics: features.slice(0, 2).map((f) => f.toLowerCase()).concat(['day one']),
      },
    ],
    campaigns: [
      {
        name: 'Problem first',
        angle: painPoints[0] ?? 'The manual way is broken',
        goal: 'Reach people who feel the problem but do not know a fix exists',
        hypothesis: 'Problem/solution hooks out-perform feature hooks for a cold audience',
      },
      {
        name: 'Show the product',
        angle: 'Watch it happen on screen',
        goal: 'Convert interest into signups',
        hypothesis: 'Demo content drives more profile visits than educational content',
      },
      {
        name: 'Built in public',
        angle: 'Founder story and the reason this exists',
        goal: 'Build a following that sticks around between launches',
        hypothesis: 'Personality content lifts follower growth even at lower reach',
      },
    ],
  };
}

/* ── Brand ──────────────────────────────────────────────────────────────── */

function composeBrand(ctx: Ctx, system: string): unknown {
  const a = ctx.analysis ?? {};
  const strategy = ctx.strategy ?? {};
  const name: string = ctx.project_name ?? 'the product';
  const technical = /developer|cli|api/i.test(a.category ?? '');

  return {
    voice: technical
      ? 'Direct and technical. Short sentences. Shows the thing rather than describing it.'
      : 'Confident and plain-spoken. Leads with the outcome, skips the jargon.',
    tone_attributes: technical
      ? ['direct', 'precise', 'unfussy', 'credible']
      : ['confident', 'warm', 'practical', 'energetic'],
    audience: strategy.audience_summary ?? a.target_market ?? 'Early adopters',
    messaging_pillars: [
      a.one_liner ?? `${name} does the work for you`,
      strategy.positioning ?? 'Built for people who feel this problem weekly',
      ...(a.differentiators ?? []).slice(0, 2),
    ].filter(Boolean),
    terminology: Object.fromEntries(
      (a.features ?? []).slice(0, 5).map((f: any) => [f.name, f.description]),
    ),
    visual_style: 'Clean product screens, high contrast, real UI over stock imagery',
    words_to_use: [
      ...(a.features ?? []).slice(0, 4).map((f: any) => String(f.name).toLowerCase()),
      'actually',
      'in seconds',
      'without',
    ],
    words_to_avoid: [
      'revolutionary',
      'game-changer',
      'unlock the power of',
      'seamlessly',
      'best-in-class',
      'synergy',
      'delve',
      'in today’s fast-paced world',
    ],
    positioning: strategy.positioning ?? a.one_liner ?? '',
    ctas: strategy.cta_strategy ?? ['Link in bio', 'Save this'],
    emoji_policy: technical ? 'none' : 'sparing',
    _system_len: system.length,
  };
}

/* ── Content ────────────────────────────────────────────────────────────── */

const HOOK_PATTERNS: Record<PillarType, string[]> = {
  education: [
    'Nobody tells you this about {topic}',
    'The fastest way to {verb} — in {n} seconds',
    'You are doing {topic} the hard way',
    '{n} things about {topic} I wish I knew earlier',
  ],
  product_demo: [
    'Watch {product} {verb} in real time',
    'This used to take an hour. Now it takes {n} seconds.',
    'Here is exactly how to {verb} in {product}',
    'Before / after: {topic}',
  ],
  entertainment: [
    'POV: you finally found something that {verb}s for you',
    'Me explaining why I built {product}',
    'Things that made me build {product}',
    'The manual version of {topic} vs. this',
  ],
  social_proof: [
    'What happened in week one of {product}',
    'The first thing people say about {product}',
    'Someone asked for {topic}. So we built it.',
    'Real results from {product}',
  ],
  promotion: [
    '{product} — what you get on day one',
    'Stop doing {topic} manually',
    'If you {verb}, this is for you',
    'This is {product}. Here is the whole thing.',
  ],
};

function composeContentBatch(ctx: Ctx): unknown {
  const briefs: any[] = ctx.briefs ?? [];
  const a = ctx.analysis ?? {};
  const brand = ctx.brand ?? {};
  const productName: string = ctx.project_name ?? 'this';
  const features: any[] = a.features ?? [];
  const screens: any[] = a.screens ?? [];

  /*
   * Hooks already used, so this batch does not re-tread them.
   *
   * The caller supplies these for exactly this purpose. Ignoring them is not a
   * cosmetic failing: a top-up run derives its hooks from the same patterns as
   * the original run, the deduplicator correctly rejects every one, and the
   * autopilot reports "Nothing new passed the duplicate check" and produces
   * nothing — a content machine that quietly stops, which is the failure mode
   * it exists to prevent.
   */
  const used = new Set<string>(
    (ctx.existing_hooks ?? []).map((h: string) => normalizeHook(h)),
  );

  const items = briefs.map((brief, idx) => {
    const pillar: PillarType = brief.pillar_type ?? 'education';
    const platform: Platform = brief.platform ?? 'instagram';
    const format: ContentFormat = brief.format ?? 'reel';
    const seed = `${brief.seed ?? ''}:${idx}:${pillar}:${platform}:${format}`;

    const feature = features.length ? features[idx % features.length] : null;
    const screen = screens.length ? screens[idx % screens.length] : null;
    // Topics arrive as headlines ("How to X in 10 seconds"); hook templates
    // need the subject, not the whole sentence.
    const topic = topicSubject(brief.topic ?? feature?.name ?? a.category ?? 'this');
    const verb = verbFor(topic, a);
    const n = 3 + (Math.floor(rand(seed + 'n') * 4) % 5);

    /*
     * Start where the seed points, then walk the patterns for one that has not
     * been used. Starting from the seed keeps output stable for a given slot;
     * walking from there keeps a second pass over the same pillar from
     * repeating the first. Every pattern taken means the calendar genuinely has
     * no unused angle left for this pillar, so the last one stands and the
     * deduplicator decides — a repeat is caught there, never shipped.
     */
    const patterns = HOOK_PATTERNS[pillar];
    const start = patterns.indexOf(pick(patterns, seed + 'hook'));
    let hook = '';
    for (let step = 0; step < patterns.length; step++) {
      hook = patterns[(start + step) % patterns.length]
        .replace('{topic}', String(topic).toLowerCase())
        .replace('{product}', productName)
        .replace('{verb}', verb)
        .replace('{n}', String(n));
      if (!used.has(normalizeHook(hook))) break;
    }
    used.add(normalizeHook(hook));

    const persona = (ctx.personas ?? [])[idx % Math.max(1, (ctx.personas ?? []).length)];
    const cta = pick(brand.ctas?.length ? brand.ctas : ['Link in bio'], seed + 'cta');

    const body = bodyFor(pillar, {
      productName,
      topic: String(topic),
      feature,
      screen,
      persona,
      analysis: a,
      n,
      // Rotates the caption phrasing so two posts in the same pillar don't
      // read as the same post with the nouns swapped.
      variant: Math.floor(rand(seed + 'body') * 3),
    });

    const base: any = {
      platform,
      format,
      pillar_type: pillar,
      hook,
      caption: `${hook}\n\n${body.caption}\n\n${cta}`,
      cta,
      hashtags: hashtagsFor(a, platform, pillar),
      script: null,
      slides: null,
      video_plan: null,
    };

    if (format === 'carousel') {
      base.slides = body.slides;
    }
    if (format === 'reel' || format === 'short_video' || format === 'story') {
      base.script = body.script;
      base.video_plan = {
        total_duration_seconds: body.scenes.reduce(
          (s: number, sc: any) => s + sc.duration_seconds,
          0,
        ),
        hook_text: hook,
        scenes: body.scenes,
        narration_script: body.script,
        music_direction: 'Driving, percussive, no vocals. Cut on the beat at each scene change.',
        cta_text: cta,
        rendered_url: null,
        render_status: 'package_only',
        render_note: null,
      };
    }
    return base;
  });

  return { items };
}

/**
 * Reduces a topic headline to its subject. "How to schedule posts in 10
 * seconds" becomes "schedule posts"; "3 things about analytics" becomes
 * "analytics". Keeps hooks reading like sentences instead of stitched labels.
 */
export function topicSubject(topic: string): string {
  let t = topic.trim();
  t = t.replace(/^\s*\d+\s+(?:things?|ways?|reasons?)\s+(?:about|to|you)\s+/i, '');
  t = t.replace(/^how\s+to\s+/i, '');
  t = t.replace(/^(?:the\s+)?(?:best|fastest|easiest)\s+way\s+to\s+/i, '');
  t = t.replace(/\s+(?:in|under)\s+\d+\s*\w+\.?$/i, '');
  t = t.replace(/,\s*start\s+to\s+finish\.?$/i, '');
  t = t.replace(/[.!?]+$/, '');
  return t.trim() || topic.trim();
}

function verbFor(topic: string, a: Ctx): string {
  const t = topic.toLowerCase();
  if (/schedul|calendar/.test(t)) return 'schedule';
  if (/analy|report|metric/.test(t)) return 'analyse';
  if (/generat|creat|build/.test(t)) return 'generate';
  if (/publish|post|send/.test(t)) return 'publish';
  if (/track|monitor/.test(t)) return 'track';
  if (/connect|integrat|auth/.test(t)) return 'connect';
  if (/search|find/.test(t)) return 'search';
  return /ai/i.test(a.category ?? '') ? 'automate' : 'do it';
}

/** Caption phrasings per pillar. The variant index picks one. */
const CAPTION_VARIANTS: Record<PillarType, ((v: CaptionVars) => string)[]> = {
  education: [
    (v) =>
      `Most people handle ${v.topic} by hand. It works until it doesn't.\n\nHere's the shorter path — no extra tools, no setup ritual.`,
    (v) =>
      `${v.topic} is one of those things everyone does slightly differently and nobody does well.\n\nThis is the version that holds up when you're busy.`,
    (v) =>
      `Nobody sits you down and explains ${v.topic}. You just pick it up badly and keep going.\n\nSo here it is, properly.`,
  ],
  product_demo: [
    (v) =>
      `This is ${v.screenName} in ${v.productName}. ${v.featureName} start to finish, nothing cut.\n\nEvery step you're seeing is the real thing.`,
    (v) =>
      `No mockups. This is ${v.screenName}, running, at normal speed.\n\n${v.featureName} takes about as long as reading this caption.`,
    (v) =>
      `Watch ${v.featureName.toLowerCase()} happen in ${v.productName}.\n\nOne pass, no edits, no "and then it magically works".`,
  ],
  entertainment: [
    (v) => `I built this because ${v.pain} was eating my week.\n\nTurns out I wasn't the only one.`,
    (v) =>
      `The honest origin story: ${v.pain}, every single week, until I got annoyed enough to fix it.\n\n${v.productName} is what came out.`,
    (v) =>
      `Nobody asked for this. I just could not do ${v.featureName.toLowerCase()} by hand one more time.\n\nSo now it does itself.`,
  ],
  social_proof: [
    (v) =>
      `The thing people keep saying about ${v.productName}: it's the ${v.featureName.toLowerCase()} that changes the day.\n\nHere's what that looks like in practice.`,
    (v) =>
      `First thing new users go for: ${v.featureName.toLowerCase()}.\n\nSecond thing: asking why it wasn't always like this.`,
    (v) =>
      `Someone asked for a better way to handle ${v.topic}. So that's what ${v.productName} does now.`,
  ],
  promotion: [
    (v) =>
      `${v.productName} handles ${v.featureName.toLowerCase()} so you don't have to think about it.\n\nThat's the whole pitch.`,
    (v) => `If ${v.topic} is on your plate every week, ${v.productName} takes it off.`,
    (v) =>
      `${v.productName}, plainly: ${v.featureName.toLowerCase()}, done for you.\n\nNo trial gimmicks, no onboarding maze.`,
  ],
};

interface CaptionVars {
  productName: string;
  topic: string;
  featureName: string;
  screenName: string;
  pain: string;
}

function bodyFor(
  pillar: PillarType,
  p: {
    productName: string;
    topic: string;
    feature: any;
    screen: any;
    persona: any;
    analysis: Ctx;
    n: number;
    variant: number;
  },
) {
  const { productName, topic, feature, screen, persona, analysis, n, variant } = p;
  const pain = String(
    persona?.pain_points?.[0] ?? analysis.problem_solved ?? 'the manual way',
  ).toLowerCase();
  const featureName = feature?.name ?? topic;
  const screenName = screen?.name ?? 'the main screen';

  const vars: CaptionVars = {
    productName,
    topic: topic.toLowerCase(),
    featureName,
    screenName,
    pain,
  };
  const options = CAPTION_VARIANTS[pillar];
  const caption = options[variant % options.length](vars);

  /*
   * Education carousels are built from the product's own feature list.
   *
   * They used to be four hardcoded aphorisms — "Start smaller than you think",
   * "Automate the repeat, not the decision", "Measure one thing", "Ship before
   * it feels ready" — each under the identical body "Applies directly to
   * {topic}." That is four slides that say one thing, and the one thing is not
   * about the product. A carousel of it published to a real Instagram account
   * and read as blank.
   *
   * The material to do better was already here. `analysis.features` comes from
   * README headings and routes — evidence from the repository, not invention —
   * and every feature has a name and usually a description. One slide each
   * gives a carousel that is genuinely about the product and genuinely varied,
   * because the features differ from one another.
   *
   * Where a feature has no description, the sentence is built around its name,
   * which still differs per slide. Nothing here can produce two identical
   * bodies, which is what `qc/check.ts` now blocks.
   */
  const namedFeatures: { name: string; description?: string }[] = (analysis.features ?? [])
    .filter((f: any) => typeof f?.name === 'string' && f.name.trim().length > 0)
    .slice(0, 5);

  const educationSlides =
    namedFeatures.length >= 2
      ? [
          { headline: `${namedFeatures.length} things ${productName} does`, body: 'Swipe →' },
          ...namedFeatures.map((f, i) => ({
            headline: `${i + 1}. ${f.name}`,
            body:
              String(f.description ?? '').trim() ||
              `${f.name} is how ${productName} handles ${topic.toLowerCase()}.`,
          })),
          { headline: `That's it.`, body: `${productName} does all of this for you.` },
        ]
      : // Too little to say for a list. A short, honest carousel beats a padded
        // one — the alternative is inventing features to fill slides.
        [
          { headline: featureName, body: `Inside ${productName}` },
          { headline: 'The old way', body: String(pain) },
          { headline: 'The new way', body: `${featureName}, handled.` },
        ];

  const slides =
    pillar === 'education'
      ? educationSlides
      : [
          { headline: featureName, body: `Inside ${productName}` },
          { headline: 'The old way', body: String(pain) },
          { headline: 'The new way', body: `${featureName}, handled.` },
          { headline: 'Try it', body: 'Link in bio' },
        ];

  const scenes = [
    {
      index: 0,
      duration_seconds: 3,
      visual: `Tight shot of ${screenName}, cursor already moving`,
      on_screen_text: topic.toUpperCase(),
      narration: `This is ${topic.toLowerCase()}.`,
      screen_reference: screen?.name ?? null,
    },
    {
      index: 1,
      duration_seconds: 5,
      visual: `The problem: the manual version, sped up and painful`,
      on_screen_text: 'THE OLD WAY',
      narration: `Normally this means ${String(pain).toLowerCase()}.`,
      screen_reference: null,
    },
    {
      index: 2,
      duration_seconds: 8,
      visual: `${featureName} running in ${productName}, real time, no cuts`,
      on_screen_text: featureName.toUpperCase(),
      narration: `In ${productName}, ${featureName.toLowerCase()} takes one step.`,
      screen_reference: screen?.name ?? null,
    },
    {
      index: 3,
      duration_seconds: 4,
      visual: 'Result on screen, then hard cut to the logo',
      on_screen_text: 'DONE',
      narration: `That's it. Link in bio.`,
      screen_reference: null,
    },
  ];

  const script = scenes.map((s) => `[${s.duration_seconds}s] ${s.narration}`).join('\n');
  return { caption, slides, scenes, script };
}

function hashtagsFor(a: Ctx, platform: Platform, pillar: PillarType): string[] {
  const cat = String(a.category ?? 'software').toLowerCase().replace(/[^a-z]/g, '');
  const base = platform === 'tiktok' ? ['buildinpublic', 'techtok'] : ['buildinpublic', 'saas'];
  const stack = (a.tech_stack ?? [])
    .slice(0, 2)
    .map((s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const byPillar: Record<PillarType, string[]> = {
    education: ['howto', 'productivity'],
    product_demo: ['productdemo', 'softwaredemo'],
    entertainment: ['founderlife', 'startup'],
    social_proof: ['customerstory', 'results'],
    promotion: ['launch', 'newapp'],
  };
  return [...new Set([...base, cat, ...stack, ...byPillar[pillar]])]
    .filter((t) => t && t.length > 2)
    .slice(0, platform === 'tiktok' ? 6 : 10)
    .map((t) => `#${t}`);
}

/* ── Optimizer & reporting ──────────────────────────────────────────────── */

function composeRecommendations(ctx: Ctx): unknown {
  const stats: any[] = ctx.format_performance ?? [];
  const pillarStats: any[] = ctx.pillar_performance ?? [];
  const recs: any[] = [];

  const sortedFormats = [...stats].sort((a, b) => b.mean_engagement - a.mean_engagement);
  const best = sortedFormats[0];
  const worst = sortedFormats[sortedFormats.length - 1];

  if (best && worst && best.format !== worst.format && worst.mean_engagement > 0) {
    const ratio = best.mean_engagement / worst.mean_engagement;
    if (ratio >= 1.3 && best.samples >= 3) {
      recs.push({
        statement: `${titleCase(best.format)}s are outperforming ${worst.format}s ${ratio.toFixed(1)}x. I'm increasing ${best.format}s next week.`,
        rationale: `Across ${best.samples} posts, ${best.format} averaged ${Math.round(best.mean_engagement)} engagements vs ${Math.round(worst.mean_engagement)} for ${worst.format}.`,
        evidence: [
          { label: `${best.format} avg engagement`, value: String(Math.round(best.mean_engagement)) },
          { label: `${worst.format} avg engagement`, value: String(Math.round(worst.mean_engagement)) },
          { label: 'Sample size', value: `${best.samples} posts` },
        ],
        action: {
          type: 'increase_format',
          platform: best.platform ?? 'instagram',
          format: best.format,
          per_week: 2,
        },
        confidence: Math.min(0.9, 0.5 + best.samples * 0.05),
      });
    }
  }

  const sortedPillars = [...pillarStats].sort((a, b) => b.mean_engagement - a.mean_engagement);
  const bestPillar = sortedPillars[0];
  const worstPillar = sortedPillars[sortedPillars.length - 1];
  if (
    bestPillar &&
    worstPillar &&
    bestPillar.pillar !== worstPillar.pillar &&
    bestPillar.samples >= 3 &&
    bestPillar.mean_engagement > worstPillar.mean_engagement * 1.25
  ) {
    const pct = Math.round(
      ((bestPillar.mean_engagement - worstPillar.mean_engagement) /
        Math.max(1, worstPillar.mean_engagement)) *
        100,
    );
    recs.push({
      statement: `${titleCase(bestPillar.pillar)} content is beating ${worstPillar.pillar.replace('_', ' ')} by ${pct}%. Shifting the mix.`,
      rationale: `Your audience responds to ${bestPillar.pillar.replace('_', ' ')}. Moving 10 points of the calendar there.`,
      evidence: [
        { label: `${bestPillar.pillar} avg`, value: String(Math.round(bestPillar.mean_engagement)) },
        {
          label: `${worstPillar.pillar} avg`,
          value: String(Math.round(worstPillar.mean_engagement)),
        },
      ],
      action: {
        type: 'shift_mix',
        from: worstPillar.pillar,
        to: bestPillar.pillar,
        points: 10,
      },
      confidence: 0.72,
    });
  }

  if (recs.length === 0) {
    const posted = ctx.posts_analyzed ?? 0;
    recs.push({
      statement:
        posted > 0
          ? `Not enough signal yet across ${posted} posts. Holding the current mix and adding volume.`
          : 'No published posts yet. Building the first batch and getting it out the door.',
      rationale:
        'Changing the mix on thin data is how you chase noise. More posts first, then optimise.',
      evidence: [{ label: 'Posts analysed', value: String(posted) }],
      action: {
        type: 'generate_content',
        count: 6,
        brief: 'Keep the current mix, prioritise formats with zero samples so far',
      },
      confidence: 0.6,
    });
  }
  return { recommendations: recs };
}

function composeWeeklyInsight(ctx: Ctx): unknown {
  const bestFormat = ctx.best_format ?? null;
  const bestHook = ctx.best_hook ?? null;
  const reach = ctx.reach ?? 0;
  const prevReach = ctx.previous_reach ?? 0;
  const delta = prevReach > 0 ? Math.round(((reach - prevReach) / prevReach) * 100) : null;

  return {
    biggest_learning: bestFormat
      ? `${titleCase(String(bestFormat))} is carrying the account this week${
          bestHook ? `, and hooks like "${String(bestHook).slice(0, 60)}" are what stop the scroll` : ''
        }.`
      : 'Volume is still the constraint — there is not enough published content to read a pattern yet.',
    next_week_strategy: bestFormat
      ? `Increase ${bestFormat} output, reuse the winning hook structure on a new topic, and keep one experiment slot for a format with no data yet.${
          delta !== null ? ` Reach moved ${delta >= 0 ? '+' : ''}${delta}% week over week.` : ''
        }`
      : 'Ship the full planned calendar without changes, then re-read the numbers with a real sample.',
  };
}
