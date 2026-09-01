/**
 * Environment access.
 *
 * Everything here is server-only except the handful of NEXT_PUBLIC_ values.
 * Nothing in this module may be imported from a client component — the
 * `server-only` guard makes that a build error rather than a leak.
 */
import 'server-only';

function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function req(name: string): string {
  const v = opt(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/**
 * The public origin, and why it is not simply an environment variable.
 *
 * Every OAuth redirect URI is built from this. A production deployment missing
 * `NEXT_PUBLIC_APP_URL` used to fall straight through to `http://localhost:3000`
 * and send Meta a callback pointing at the founder's own machine — a
 * development default silently overriding production, which is the one thing
 * this value must never do.
 *
 * `VERCEL_PROJECT_PRODUCTION_URL` is the stable production domain, so it is the
 * fallback that can actually be registered with Meta. `VERCEL_URL` changes
 * every deploy and is only useful for previews. Localhost is last, and
 * `appUrlIsLocal` lets the OAuth routes refuse rather than send it to a
 * platform.
 */
function resolveAppUrl(): string {
  const explicit = opt('NEXT_PUBLIC_APP_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  const production = opt('VERCEL_PROJECT_PRODUCTION_URL');
  if (production) return `https://${production}`;
  const deployment = opt('VERCEL_URL');
  if (deployment) return `https://${deployment}`;
  return 'http://localhost:3000';
}

const APP_URL = resolveAppUrl();

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  appUrl: APP_URL,
  /** True when the resolved origin is a developer machine, not a deployment. */
  appUrlIsLocal: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(APP_URL),

  /** `supabase` in production; `memory` runs the whole product in-process. */
  dbDriver: (opt('FULLSEND_DB_DRIVER') ?? (opt('SUPABASE_SERVICE_ROLE_KEY') ? 'supabase' : 'memory')) as
    | 'supabase'
    | 'memory',

  supabase: {
    url: opt('NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: opt('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    serviceRoleKey: opt('SUPABASE_SERVICE_ROLE_KEY'),
    /*
     * A direct Postgres connection, used for one thing: applying migrations.
     *
     * The service-role key cannot do it — PostgREST speaks tables, not DDL —
     * so without this, every schema change needs a person with the SQL editor
     * open. Optional: unset, FullSend reports what is missing and asks for it
     * to be run by hand, exactly as before.
     */
    dbUrl: opt('SUPABASE_DB_URL'),
    storageBucket: opt('SUPABASE_STORAGE_BUCKET') ?? 'fullsend-creative',
  },

  /** 32-byte key, base64 or hex, used for AES-256-GCM at-rest token encryption. */
  encryptionKey: opt('FULLSEND_ENCRYPTION_KEY'),

  github: {
    clientId: opt('GITHUB_CLIENT_ID'),
    clientSecret: opt('GITHUB_CLIENT_SECRET'),
    /** Optional PAT for analysing public repos without user OAuth. */
    token: opt('GITHUB_TOKEN'),
    apiBase: opt('GITHUB_API_BASE') ?? 'https://api.github.com',
  },

  ai: {
    anthropicKey: opt('ANTHROPIC_API_KEY'),
    openaiKey: opt('OPENAI_API_KEY'),
    /** `anthropic` | `openai` | `mock`. Defaults to whichever key is present. */
    provider: (opt('FULLSEND_AI_PROVIDER') ??
      (opt('ANTHROPIC_API_KEY') ? 'anthropic' : opt('OPENAI_API_KEY') ? 'openai' : 'mock')) as
      | 'anthropic'
      | 'openai'
      | 'mock',
    monthlyBudgetUsd: Number(opt('FULLSEND_AI_MONTHLY_BUDGET_USD') ?? '50'),
  },

  meta: {
    appId: opt('META_APP_ID'),
    appSecret: opt('META_APP_SECRET'),
    /** Graph API version, e.g. v23.0. Bump when Meta deprecates. */
    graphVersion: opt('META_GRAPH_VERSION') ?? 'v23.0',
    graphHost: opt('META_GRAPH_HOST') ?? 'https://graph.facebook.com',
    instagramGraphHost: opt('INSTAGRAM_GRAPH_HOST') ?? 'https://graph.instagram.com',
    /*
     * `instagram_login` (Instagram API with Instagram Login) or
     * `facebook_login`.
     *
     * Instagram Login is the default because it is the one whose permissions
     * still exist. Meta retired `instagram_basic` and `instagram_content_publish`
     * on 27 January 2025 in favour of the `instagram_business_*` names, and
     * those are what the Instagram Login path asks for. It is also the simpler
     * setup — no Facebook Page in the middle. Choose `facebook_login` only for
     * managing several accounts through Business Manager, and check its scope
     * names against Meta's current documentation first.
     */
    loginMode: (opt('META_LOGIN_MODE') ?? 'instagram_login') as 'instagram_login' | 'facebook_login',
    webhookVerifyToken: opt('META_WEBHOOK_VERIFY_TOKEN'),
  },

  tiktok: {
    clientKey: opt('TIKTOK_CLIENT_KEY'),
    clientSecret: opt('TIKTOK_CLIENT_SECRET'),
    apiHost: opt('TIKTOK_API_HOST') ?? 'https://open.tiktokapis.com',
    authHost: opt('TIKTOK_AUTH_HOST') ?? 'https://www.tiktok.com',
    /** Set true once TikTok has audited the client; gates PUBLIC_TO_EVERYONE. */
    audited: opt('TIKTOK_CLIENT_AUDITED') === 'true',
  },

  stripe: {
    secretKey: opt('STRIPE_SECRET_KEY'),
    webhookSecret: opt('STRIPE_WEBHOOK_SECRET'),
    publishableKey: opt('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'),
    priceSend: opt('STRIPE_PRICE_SEND'),
    priceFullSend: opt('STRIPE_PRICE_FULL_SEND'),
    priceAgency: opt('STRIPE_PRICE_AGENCY'),
    get enabled() {
      return Boolean(opt('STRIPE_SECRET_KEY'));
    },
  },

  jobs: {
    /** Shared secret required by every /api/cron/* route. */
    cronSecret: opt('CRON_SECRET'),
    maxAttempts: Number(opt('FULLSEND_JOB_MAX_ATTEMPTS') ?? '5'),
  },

  video: {
    /** `none` produces a full production package instead of a rendered file. */
    provider: (opt('FULLSEND_VIDEO_PROVIDER') ?? 'none') as 'none' | 'shotstack' | 'creatomate',
    apiKey: opt('FULLSEND_VIDEO_API_KEY'),
  },

  /**
   * Address published on the Terms, Privacy and Data Deletion pages.
   *
   * Required before submitting to TikTok or Meta: both reviewers check that a
   * policy names someone reachable, and reject the app if it does not. Left
   * unset the pages say so rather than inventing an address.
   */
  contactEmail: opt('FULLSEND_CONTACT_EMAIL'),

  /** Legal entity named in the policies. Falls back to the product name. */
  legalEntity: opt('FULLSEND_LEGAL_ENTITY') ?? 'FullSend',

  admin: {
    /** Comma-separated emails allowed into the FullSend Control Room. */
    emails: (opt('FULLSEND_ADMIN_EMAILS') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
} as const;

export function requireEnv(name: string): string {
  return req(name);
}

/** Feature availability, surfaced honestly in the UI rather than faked. */
export function capabilities() {
  return {
    database: env.dbDriver,
    auth: Boolean(env.supabase.url && env.supabase.anonKey),
    github: Boolean(env.github.clientId || env.github.token),
    githubOAuth: Boolean(env.github.clientId && env.github.clientSecret),
    ai: env.ai.provider !== 'mock',
    instagram: Boolean(env.meta.appId && env.meta.appSecret),
    tiktok: Boolean(env.tiktok.clientKey && env.tiktok.clientSecret),
    tiktokPublicPosting: env.tiktok.audited,
    storage: Boolean(env.supabase.url && env.supabase.serviceRoleKey),
    videoRender: env.video.provider !== 'none' && Boolean(env.video.apiKey),
    billing: env.stripe.enabled,
    encryption: Boolean(env.encryptionKey),
  };
}

export type Capabilities = ReturnType<typeof capabilities>;
