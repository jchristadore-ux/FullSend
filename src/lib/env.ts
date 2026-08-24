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

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  appUrl: opt('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000',

  /** `supabase` in production; `memory` runs the whole product in-process. */
  dbDriver: (opt('FULLSEND_DB_DRIVER') ?? (opt('SUPABASE_SERVICE_ROLE_KEY') ? 'supabase' : 'memory')) as
    | 'supabase'
    | 'memory',

  supabase: {
    url: opt('NEXT_PUBLIC_SUPABASE_URL'),
    anonKey: opt('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    serviceRoleKey: opt('SUPABASE_SERVICE_ROLE_KEY'),
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
    /** `instagram_login` (Instagram API with Instagram Login) or `facebook_login`. */
    loginMode: (opt('META_LOGIN_MODE') ?? 'facebook_login') as 'instagram_login' | 'facebook_login',
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
