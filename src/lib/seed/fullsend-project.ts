/**
 * FullSend markets FullSend.
 *
 * Creates the internal project and runs it through the product's own engines —
 * the same analysis, strategy, content and creative code every customer gets.
 * The five launch campaigns are seeded as real Campaign rows so the calendar
 * allocates against them.
 *
 * This is not fixture data: it is FullSend using itself.
 */
import 'server-only';
import { systemScope, type TenantScope } from '../db';
import { db, getStrategy } from '../db/repo';
import { newId, nowIso } from '../ids';
import { logger } from '../logger';
import { FULLSEND_COLORS, FULLSEND_PHRASES, FULLSEND_VOICE } from '../brand/fullsend-brand';
import { generateContent } from '../content/generate';
import { planSlots } from '../content/mix';
import { approveStrategy, normaliseMix } from '../strategy/build';
import type {
  BrandProfile,
  Campaign,
  ContentItem,
  ContentPillar,
  MarketingStrategy,
  Persona,
  ProductAnalysis,
  Project,
  Repository,
  Uuid,
} from '../types';

const log = logger('seed');

/** The five launch campaigns, verbatim from the brief. */
export const FULLSEND_CAMPAIGNS = [
  {
    name: 'Stop building apps nobody knows exist',
    angle: 'The product is done. Nobody has heard of it. That is the actual problem.',
    goal: 'Reach founders who have shipped and stalled',
    hypothesis: 'Problem-first hooks out-perform feature hooks with a cold founder audience',
  },
  {
    name: 'One command. Everything goes live.',
    angle: 'One input, and the whole marketing machine appears',
    goal: 'Show the product doing the thing in under 20 seconds',
    hypothesis: 'Watching the chain run converts better than describing it',
  },
  {
    name: 'You built the app. FullSend builds the audience.',
    angle: 'Division of labour: you keep building, this handles distribution',
    goal: 'Land the positioning in one line',
    hypothesis: 'The split framing is more memorable than any feature list',
  },
  {
    name: 'Your new AI marketing employee',
    angle: 'Not a tool you operate — something that does the job',
    goal: 'Reframe the category away from schedulers',
    hypothesis: 'Employee framing justifies the price better than tool framing',
  },
  {
    name: 'From zero to fully live',
    angle: 'The before and after of a launch that actually got attention',
    goal: 'Give the outcome a shape people can picture',
    hypothesis: 'Before/after demonstrations drive the most saves',
  },
] as const;

/** FullSend's own analysis, written from what FullSend actually does. */
const SELF_ANALYSIS: Omit<
  ProductAnalysis,
  'id' | 'project_id' | 'repository_id' | 'created_at'
> = {
  // Written by hand rather than derived from a commit, so it is keyed to none.
  commit_sha: null,
  one_liner: 'Give FullSend your app’s repo and it builds and runs the whole marketing machine.',
  what_it_does:
    'FullSend reads a GitHub repository, works out what the product actually does and who ' +
    'needs it, builds a marketing strategy, writes the content, generates the creative, ' +
    'connects Instagram and TikTok, schedules everything, publishes on time, reads the ' +
    'results back, and changes what it makes next based on what worked.',
  category: 'AI tool',
  features: [
    {
      name: 'Repository analysis',
      description: 'Reads the code, README, routes and screenshots to work out what the product is.',
      evidence: ['src/lib/github/ingest.ts', 'src/lib/analysis/analyze.ts'],
      user_facing: true,
    },
    {
      name: 'Marketing strategy generation',
      description: 'Positioning, personas, pillars, campaigns and a content mix built for one product.',
      evidence: ['src/lib/strategy/build.ts'],
      user_facing: true,
    },
    {
      name: 'Content machine',
      description: 'Real posts — hook, script, caption, CTA, hashtags — deduplicated and quality-controlled.',
      evidence: ['src/lib/content/generate.ts', 'src/lib/content/dedup.ts'],
      user_facing: true,
    },
    {
      name: 'Creative generation',
      description: 'On-brand visuals rendered per platform and rasterised for publishing.',
      evidence: ['src/lib/creative/render.ts', 'src/lib/creative/media.ts'],
      user_facing: true,
    },
    {
      name: 'Autopilot',
      description: 'Generates, schedules, publishes, measures and adjusts every day without you.',
      evidence: ['src/lib/automation/autopilot.ts'],
      user_facing: true,
    },
    {
      name: 'The Send Score',
      description: 'One number for marketing momentum, broken into the five things that move it.',
      evidence: ['src/lib/analytics/send-score.ts'],
      user_facing: true,
    },
    {
      name: 'Quality control',
      description: 'Blocks unsupported claims, spam and repetition before anything publishes.',
      evidence: ['src/lib/qc/check.ts'],
      user_facing: true,
    },
  ],
  not_capabilities: [
    'Growth or follower guarantees of any kind',
    'Posting to platforms beyond Instagram and TikTok today',
    'Rendering finished videos without a configured render provider',
    'Bypassing Meta App Review or TikTok’s content-posting audit',
    'Anything that requires scraping or automating a browser session',
  ],
  tech_stack: ['Next.js', 'React', 'TypeScript', 'Tailwind CSS', 'Supabase', 'AI APIs'],
  platforms: ['Web'],
  target_market: 'Founders and indie developers who have shipped a product nobody has heard of',
  problem_solved:
    'Building the product is the part founders can do. Getting anyone to notice it is a second ' +
    'full-time job they never signed up for.',
  differentiators: [
    'Starts from the repository, not a form — it knows what the product genuinely does',
    'Has an opinion and acts on it instead of asking what you want to post',
    'Refuses to claim anything the code cannot back up',
    'Runs daily whether or not anyone opens the app',
  ],
  maturity: 'beta',
  screens: [
    {
      name: 'The Send Center',
      route: '/app',
      purpose: 'The command centre: status, next send, what is working, and the next move.',
      key_elements: ['AUTOPILOT ACTIVE', 'Your marketing is running.', 'The Send Score'],
      workflow: 'Open the app → see whether it is running → see what goes out next',
      image_url: null,
      source_file: 'src/app/app/page.tsx',
    },
    {
      name: 'Onboarding',
      route: '/onboarding',
      purpose: 'Paste a repo, watch FullSend work out what the product is.',
      key_elements: ['What’s your app?', 'ANALYZE IT →', 'WE’VE GOT IT.'],
      workflow: 'Paste repository → analysis runs → product understanding shown',
      image_url: null,
      source_file: 'src/app/onboarding/page.tsx',
    },
    {
      name: 'Content Calendar',
      route: '/app/calendar',
      purpose: 'Every scheduled post, by day, with its real status.',
      key_elements: ['The next 30 days.', 'GENERATE 30 DAYS'],
      workflow: 'Pick a window → generate → posts appear on the calendar',
      image_url: null,
      source_file: 'src/app/app/calendar/page.tsx',
    },
  ],
  confidence: 1,
  raw_signals: { self: true },
};

export interface SeedResult {
  project: Project;
  analysis: ProductAnalysis;
  strategy: MarketingStrategy;
  campaigns: Campaign[];
  content: ContentItem[];
}

/**
 * Creates (or refreshes) the internal FullSend project and generates its
 * launch content through the real content machine.
 */
export async function seedFullSendProject(
  userId: Uuid,
  opts: { days?: number; scope?: TenantScope } = {},
): Promise<SeedResult> {
  const scope = opts.scope ?? systemScope('fullsend self-marketing seed');
  const days = opts.days ?? 30;

  const existing = await db().findOne(scope, 'projects', {
    where: { user_id: userId, is_internal: true },
  });

  const project =
    existing ??
    (await db().insert(scope, 'projects', {
      id: newId(),
      user_id: userId,
      name: 'FullSend',
      slug: 'fullsend',
      status: 'strategy_ready',
      autopilot_mode: 'full_send',
      timezone: 'UTC',
      is_internal: true,
      last_autopilot_run_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    }));

  if (!existing) {
    await db().insert(scope, 'settings', {
      id: newId(),
      project_id: project.id,
      auto_publish_pillars: ['education', 'product_demo', 'entertainment', 'social_proof'],
      require_approval_for_promotion: true,
      daily_post_cap: 3,
      quiet_hours: { start: 22, end: 7 },
      notify_email: false,
      trend_participation: true,
      updated_at: nowIso(),
    });
  }

  const repository = await upsertSelfRepository(scope, project.id);
  const analysis = await upsertSelfAnalysis(scope, project.id, repository.id);
  const personas = await upsertSelfPersonas(scope, project.id);
  const { strategy, pillars } = await upsertSelfStrategy(scope, project.id);
  const brand = await upsertSelfBrand(scope, project.id, strategy);
  const campaigns = await upsertSelfCampaigns(scope, project.id, personas);

  // Generate through the real machine — same code path as any customer.
  const slots = planSlots({
    days,
    from: new Date(),
    strategy,
    platforms: ['instagram', 'tiktok'],
    dailyCap: 3,
    quietHours: { start: 22, end: 7 },
  });

  const result = await generateContent(scope, {
    project,
    analysis,
    brand,
    strategy,
    personas,
    pillars,
    campaigns,
    slots,
    origin: 'initial',
    brief:
      'This is FullSend marketing itself. Bold, decisive, slightly irreverent. Founder to ' +
      'founder. Never corporate. Lead with the problem or show the product doing the thing.',
  });

  log.info('FullSend self-marketing seeded', {
    projectId: project.id,
    campaigns: campaigns.length,
    content: result.created.length,
  });

  return { project, analysis, strategy, campaigns, content: result.created };
}

/* ── Pieces ─────────────────────────────────────────────────────────────── */

async function upsertSelfRepository(scope: TenantScope, projectId: Uuid): Promise<Repository> {
  const existing = await db().findOne(scope, 'repositories', { where: { project_id: projectId } });
  if (existing) return existing;
  return db().insert(scope, 'repositories', {
    id: newId(),
    project_id: projectId,
    provider: 'github',
    owner: 'fullsend',
    name: 'fullsend',
    url: 'https://github.com/fullsend/fullsend',
    default_branch: 'main',
    commit_sha: null,
    description: 'FullSend. Everything goes live.',
    primary_language: 'TypeScript',
    languages: { TypeScript: 100_000 },
    topics: ['marketing-automation', 'ai', 'social-media', 'indiehackers'],
    stars: 0,
    is_private: false,
    last_indexed_at: nowIso(),
    created_at: nowIso(),
  });
}

async function upsertSelfAnalysis(
  scope: TenantScope,
  projectId: Uuid,
  repositoryId: Uuid,
): Promise<ProductAnalysis> {
  const existing = await db().findOne(scope, 'product_analysis', {
    where: { project_id: projectId },
  });
  if (existing) return existing;
  return db().insert(scope, 'product_analysis', {
    ...SELF_ANALYSIS,
    id: newId(),
    project_id: projectId,
    repository_id: repositoryId,
    created_at: nowIso(),
  });
}

async function upsertSelfPersonas(scope: TenantScope, projectId: Uuid): Promise<Persona[]> {
  const existing = await db().find(scope, 'personas', { where: { project_id: projectId } });
  if (existing.length) return existing;

  return db().insertMany(scope, 'personas', [
    {
      id: newId(),
      project_id: projectId,
      name: 'Alex the Shipped-and-Stalled Founder',
      role: 'Solo founder, one live product',
      description:
        'Shipped six months ago. The product is good. Nobody knows it exists, and every week ' +
        'without distribution makes it harder to care.',
      pain_points: [
        'Great product, zero distribution',
        'Marketing is a full second job',
        'Posts once, gets nothing, stops',
      ],
      goals: ['Get in front of real users', 'Stop guessing what to post', 'Keep building'],
      objections: ['Will it sound like me?', 'Is the output actually good?', 'Another subscription?'],
      where_they_hang_out: ['tiktok', 'instagram'],
      tone_preference: 'Peer to peer. Blunt. No marketing voice.',
      priority: 1,
      created_at: nowIso(),
    },
    {
      id: newId(),
      project_id: projectId,
      name: 'Sam the Serial Shipper',
      role: 'Indie hacker with several small products',
      description:
        'Launches often, markets none of them properly. Wants one thing that runs across ' +
        'projects without becoming a job.',
      pain_points: [
        'Too many projects, no time to market any of them',
        'Every launch starts marketing from scratch',
      ],
      goals: ['Marketing that runs itself', 'One setup per project, then nothing'],
      objections: ['Will it just post generic slop?', 'How much babysitting?'],
      where_they_hang_out: ['tiktok', 'instagram'],
      tone_preference: 'Technical, fast, unsentimental',
      priority: 2,
      created_at: nowIso(),
    },
    {
      id: newId(),
      project_id: projectId,
      name: 'Priya the Agency Operator',
      role: 'Runs marketing for several small clients',
      description:
        'Doing by hand, for ten clients, what one system should do. Charges for output she ' +
        'would rather automate.',
      pain_points: ['Same work repeated per client', 'Reporting eats a day a week'],
      goals: ['Scale clients without scaling headcount', 'Per-client reporting that writes itself'],
      objections: ['Can I keep each client on-brand?', 'What do I tell them it is?'],
      where_they_hang_out: ['instagram', 'tiktok'],
      tone_preference: 'Outcome-first, practical',
      priority: 3,
      created_at: nowIso(),
    },
  ]);
}

async function upsertSelfStrategy(
  scope: TenantScope,
  projectId: Uuid,
): Promise<{ strategy: MarketingStrategy; pillars: ContentPillar[] }> {
  const existing = await getStrategy(scope, projectId);
  if (existing) {
    const pillars = await db().find(scope, 'content_pillars', { where: { project_id: projectId } });
    return { strategy: existing, pillars };
  }

  const strategy = await db().insert(scope, 'marketing_strategies', {
    id: newId(),
    project_id: projectId,
    version: 1,
    positioning:
      'FullSend is the AI marketing employee for founders who have already shipped — it takes ' +
      'the repository and runs the distribution, instead of handing over another plan to execute.',
    value_proposition: 'You build the app. FullSend builds the audience.',
    audience_summary:
      'Founders and indie developers with a live product and no distribution; agencies running ' +
      'the same marketing motion across several clients.',
    pain_points: [
      'Great product, zero distribution',
      'Marketing is a full second job',
      'Posting stops the moment it stops being novel',
      'Every tool produces a plan, not the work',
    ],
    differentiators: SELF_ANALYSIS.differentiators,
    campaign_strategy:
      'Lead with the founder’s actual problem, prove it by showing the machine run on screen, ' +
      'and convert with one clear next step. Never demo a mockup — demo the product.',
    posting_cadence: {
      instagram_per_week: 4,
      tiktok_per_week: 5,
      best_times: [
        { day: 1, hour: 9, platform: 'instagram' },
        { day: 2, hour: 18, platform: 'tiktok' },
        { day: 3, hour: 9, platform: 'instagram' },
        { day: 4, hour: 19, platform: 'tiktok' },
        { day: 5, hour: 12, platform: 'instagram' },
        { day: 6, hour: 11, platform: 'tiktok' },
      ],
    },
    platform_strategy: [
      {
        platform: 'instagram',
        rationale: 'Carousels teach the workflow and get saved; Reels reach past the following.',
        formats: ['reel', 'carousel', 'static'],
        weight: 45,
      },
      {
        platform: 'tiktok',
        rationale: 'Best cold reach for an unknown product, and screen-recorded demos perform.',
        formats: ['short_video'],
        weight: 55,
      },
    ],
    growth_strategy:
      'Post the machine working, every week, without exception. Turn the strongest hook into a ' +
      'recurring series. Let the product’s own optimizer decide the mix after week four.',
    cta_strategy: [
      'Link in bio',
      'Comment SEND for the link',
      'Save this for your next launch',
      'Follow for the build',
    ],
    content_mix: normaliseMix({
      education: 35,
      product_demo: 30,
      entertainment: 15,
      social_proof: 10,
      promotion: 10,
    }),
    approved: false,
    approved_at: null,
    created_at: nowIso(),
  });

  const pillars = await db().insertMany(scope, 'content_pillars', [
    {
      id: newId(),
      project_id: projectId,
      name: 'Distribution is the job',
      type: 'education',
      description: 'Teach founders what actually moves a launch, product aside.',
      weight: 35,
      example_topics: ['distribution', 'the first 1000 users', 'why launches die'],
      created_at: nowIso(),
    },
    {
      id: newId(),
      project_id: projectId,
      name: 'Watch the machine run',
      type: 'product_demo',
      description: 'Real screens: repo in, calendar out.',
      weight: 30,
      example_topics: ['repository analysis', 'the content calendar', 'autopilot'],
      created_at: nowIso(),
    },
    {
      id: newId(),
      project_id: projectId,
      name: 'Founder POV',
      type: 'entertainment',
      description: 'The frustration this was built out of.',
      weight: 15,
      example_topics: ['the manual workflow', 'why this exists', 'the build'],
      created_at: nowIso(),
    },
    {
      id: newId(),
      project_id: projectId,
      name: 'Proof',
      type: 'social_proof',
      description: 'What changed for the people running it.',
      weight: 10,
      example_topics: ['the first week', 'real results', 'what users asked for'],
      created_at: nowIso(),
    },
    {
      id: newId(),
      project_id: projectId,
      name: 'The ask',
      type: 'promotion',
      description: 'Direct, occasional, unmistakable.',
      weight: 10,
      example_topics: ['autopilot', 'the send score', 'day one'],
      created_at: nowIso(),
    },
  ]);

  const approved = await approveStrategy(scope, strategy.id);
  return { strategy: approved, pillars };
}

async function upsertSelfBrand(
  scope: TenantScope,
  projectId: Uuid,
  strategy: MarketingStrategy,
): Promise<BrandProfile> {
  const existing = await db().findOne(scope, 'brand_profiles', {
    where: { project_id: projectId },
  });
  const patch = {
    voice:
      'Bold, decisive and slightly irreverent. Short sentences. Says the thing rather than ' +
      'setting it up. Founder to founder, never brand to consumer.',
    tone_attributes: [...FULLSEND_VOICE.personality],
    audience: strategy.audience_summary,
    messaging_pillars: [...FULLSEND_PHRASES.slice(0, 6)],
    terminology: {
      'The Send Center': 'The FullSend dashboard',
      'Full Send': 'The autopilot mode where FullSend runs everything itself',
      'The Send Score': 'A 0–100 read on marketing momentum',
      'Next Move': 'FullSend’s own recommendation, already acted on under Full Send',
    },
    /*
     * FullSend's own colours, on FullSend's own project, which is the one
     * place they belong. Every other project reads its palette out of its own
     * repository — see brand/discover.ts. This row is the internal project
     * FullSend uses to market itself, so here the engine and the brand really
     * are the same thing.
     */
    brand_name: 'FullSend',
    primary_color: FULLSEND_COLORS.orange,
    secondary_color: FULLSEND_COLORS.white,
    accent_color: FULLSEND_COLORS.orange,
    background_color: FULLSEND_COLORS.void,
    text_color: FULLSEND_COLORS.white,
    heading_font: 'Archivo, Helvetica Neue, Arial, sans-serif',
    body_font: 'Archivo, Helvetica Neue, Arial, sans-serif',
    logo_url: null,
    logo_dark_url: null,
    visual_style:
      'Dark command centre. Electric orange accent, white type, sharp edges, real UI over stock ' +
      'imagery. No gradients, no purple AI aesthetic.',
    design_language: 'Dense, high-contrast, terminal-adjacent. Sharp corners, hard rules, no soft shadows.',
    imagery_style: 'Real product UI and real numbers. Never stock photography, never abstract 3D.',
    graphic_style: 'Flat, typographic, one accent colour doing all the work.',
    icon_style: 'Minimal line icons, uniform stroke, no fills.',
    brand_personality: 'Bold, decisive, slightly irreverent. Founder to founder.',
    brand_keywords: ['autonomous', 'marketing engine', 'full send', 'founder', 'shipping'],
    visual_dos: ['Use the orange as a single accent', 'Show real product UI', 'Keep type tight and large'],
    visual_donts: [
      'Never use another product’s colours, typefaces or logo',
      'No gradients',
      'No purple AI aesthetic',
      'No stock photography',
    ],
    content_dos: ['Say the thing', 'Lead with the result', 'One call to action'],
    content_donts: ['No rhetorical throat-clearing', 'No claims the product cannot back'],
    words_to_use: [...FULLSEND_VOICE.wordsToUse],
    words_to_avoid: [...FULLSEND_VOICE.wordsToAvoid],
    positioning: strategy.positioning,
    ctas: strategy.cta_strategy,
    emoji_policy: 'sparing' as const,
    identity_sources: {},
    locked_fields: [],
    identity_discovered_at: null,
    updated_at: nowIso(),
  };

  if (existing) return db().update(scope, 'brand_profiles', existing.id, patch);
  return db().insert(scope, 'brand_profiles', { id: newId(), project_id: projectId, ...patch });
}

async function upsertSelfCampaigns(
  scope: TenantScope,
  projectId: Uuid,
  personas: Persona[],
): Promise<Campaign[]> {
  const existing = await db().find(scope, 'campaigns', { where: { project_id: projectId } });
  if (existing.length) return existing;

  const start = new Date();
  return db().insertMany(
    scope,
    'campaigns',
    FULLSEND_CAMPAIGNS.map((c, i) => {
      const startsAt = new Date(start.getTime() + i * 14 * 86_400_000);
      return {
        id: newId(),
        project_id: projectId,
        name: c.name,
        angle: c.angle,
        goal: c.goal,
        hypothesis: c.hypothesis,
        target_persona_id: personas[i % Math.max(1, personas.length)]?.id ?? null,
        platforms: ['instagram' as const, 'tiktok' as const],
        starts_at: startsAt.toISOString(),
        ends_at: new Date(startsAt.getTime() + 14 * 86_400_000).toISOString(),
        status: i === 0 ? ('active' as const) : ('planned' as const),
        created_at: nowIso(),
      };
    }),
  );
}
