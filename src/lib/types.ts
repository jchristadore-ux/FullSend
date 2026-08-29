/**
 * FullSend domain model.
 *
 * Client- and server-safe: types only, no runtime imports of server modules.
 */

export type Uuid = string;
export type IsoDate = string;

/* ── Platforms ──────────────────────────────────────────────────────────── */

export const PLATFORMS = [
  'instagram',
  'tiktok',
  'youtube_shorts',
  'linkedin',
  'facebook',
  'x',
  'pinterest',
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Platforms FullSend can actually publish to today. */
export const LIVE_PLATFORMS: Platform[] = ['instagram', 'tiktok'];

export const CONTENT_FORMATS = [
  'reel',
  'carousel',
  'static',
  'story',
  'short_video',
  'text',
] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

/* ── Users, projects, tenancy ───────────────────────────────────────────── */

export interface User {
  id: Uuid;
  email: string;
  name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  created_at: IsoDate;
}

export type ProjectStatus =
  | 'created'
  | 'analyzing'
  | 'analyzed'
  | 'strategy_ready'
  | 'content_ready'
  | 'live'
  | 'paused'
  | 'failed';

export type AutopilotMode = 'manual' | 'hybrid' | 'full_send';

export interface Project {
  id: Uuid;
  user_id: Uuid;
  name: string;
  slug: string;
  status: ProjectStatus;
  autopilot_mode: AutopilotMode;
  timezone: string;
  /** Marks FullSend's own internal project, which markets FullSend itself. */
  is_internal: boolean;
  last_autopilot_run_at: IsoDate | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface Repository {
  id: Uuid;
  project_id: Uuid;
  provider: 'github';
  owner: string;
  name: string;
  url: string;
  default_branch: string;
  description: string | null;
  primary_language: string | null;
  languages: Record<string, number>;
  topics: string[];
  stars: number;
  is_private: boolean;
  last_indexed_at: IsoDate | null;
  created_at: IsoDate;
}

/* ── Product understanding ──────────────────────────────────────────────── */

export interface ProductFeature {
  name: string;
  description: string;
  /** Where in the repo this feature was evidenced — keeps claims grounded. */
  evidence: string[];
  user_facing: boolean;
}

export interface ProductAnalysis {
  id: Uuid;
  project_id: Uuid;
  repository_id: Uuid;
  /** One-sentence answer to "what is this?". */
  one_liner: string;
  what_it_does: string;
  category: string;
  /** Verified capabilities. Content may never claim beyond this list. */
  features: ProductFeature[];
  /** Explicit non-capabilities, so QC can catch overclaiming. */
  not_capabilities: string[];
  tech_stack: string[];
  platforms: string[];
  target_market: string;
  problem_solved: string;
  differentiators: string[];
  maturity: 'prototype' | 'alpha' | 'beta' | 'production';
  /** Screens/workflows found in the repo, used for product-demo content. */
  screens: AppScreen[];
  confidence: number;
  raw_signals: Record<string, unknown>;
  created_at: IsoDate;
}

export interface AppScreen {
  name: string;
  route: string | null;
  purpose: string;
  key_elements: string[];
  workflow: string | null;
  /** A screenshot in the repo (docs, README) if one was found. */
  image_url: string | null;
  source_file: string | null;
}

export interface Persona {
  id: Uuid;
  project_id: Uuid;
  name: string;
  role: string;
  description: string;
  pain_points: string[];
  goals: string[];
  objections: string[];
  where_they_hang_out: Platform[];
  tone_preference: string;
  priority: number;
  created_at: IsoDate;
}

/* ── Strategy & brand ───────────────────────────────────────────────────── */

export interface MarketingStrategy {
  id: Uuid;
  project_id: Uuid;
  version: number;
  positioning: string;
  value_proposition: string;
  audience_summary: string;
  pain_points: string[];
  differentiators: string[];
  campaign_strategy: string;
  posting_cadence: PostingCadence;
  platform_strategy: PlatformStrategy[];
  growth_strategy: string;
  cta_strategy: string[];
  /** Content mix by pillar type, summing to 100. Optimizer mutates this. */
  content_mix: ContentMix;
  approved: boolean;
  approved_at: IsoDate | null;
  created_at: IsoDate;
}

export interface PostingCadence {
  instagram_per_week: number;
  tiktok_per_week: number;
  best_times: { day: number; hour: number; platform: Platform }[];
}

export interface PlatformStrategy {
  platform: Platform;
  rationale: string;
  formats: ContentFormat[];
  weight: number;
}

export type PillarType =
  | 'education'
  | 'product_demo'
  | 'entertainment'
  | 'social_proof'
  | 'promotion';

export type ContentMix = Record<PillarType, number>;

export interface ContentPillar {
  id: Uuid;
  project_id: Uuid;
  name: string;
  type: PillarType;
  description: string;
  /** Share of the calendar, 0-100. Adjusted by the optimizer over time. */
  weight: number;
  example_topics: string[];
  created_at: IsoDate;
}

export interface BrandProfile {
  id: Uuid;
  project_id: Uuid;
  voice: string;
  tone_attributes: string[];
  audience: string;
  messaging_pillars: string[];
  terminology: Record<string, string>;
  primary_color: string;
  secondary_color: string;
  background_color: string;
  visual_style: string;
  words_to_use: string[];
  words_to_avoid: string[];
  positioning: string;
  ctas: string[];
  emoji_policy: 'none' | 'sparing' | 'liberal';
  updated_at: IsoDate;
}

export interface Campaign {
  id: Uuid;
  project_id: Uuid;
  name: string;
  angle: string;
  goal: string;
  hypothesis: string;
  target_persona_id: Uuid | null;
  platforms: Platform[];
  starts_at: IsoDate;
  ends_at: IsoDate;
  status: 'planned' | 'active' | 'complete' | 'archived';
  created_at: IsoDate;
}

/* ── Content ────────────────────────────────────────────────────────────── */

export type ContentStatus =
  | 'draft'
  | 'approval_required'
  | 'approved'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'review_required';

export interface VideoScene {
  index: number;
  duration_seconds: number;
  visual: string;
  on_screen_text: string;
  narration: string;
  /** References an AppScreen name when the scene shows the real product. */
  screen_reference: string | null;
}

export interface VideoPlan {
  total_duration_seconds: number;
  hook_text: string;
  scenes: VideoScene[];
  narration_script: string;
  music_direction: string;
  cta_text: string;
  /** Set when a real render was produced. Never set speculatively. */
  rendered_url: string | null;
  render_status: 'not_attempted' | 'package_only' | 'queued' | 'rendered' | 'failed';
  render_note: string | null;
}

export interface ContentItem {
  id: Uuid;
  project_id: Uuid;
  campaign_id: Uuid | null;
  pillar_id: Uuid | null;
  persona_id: Uuid | null;
  platform: Platform;
  format: ContentFormat;
  hook: string;
  script: string | null;
  caption: string;
  cta: string;
  hashtags: string[];
  video_plan: VideoPlan | null;
  /** Carousel slide copy, when format is carousel. */
  slides: { headline: string; body: string }[] | null;
  creative_asset_ids: Uuid[];
  status: ContentStatus;
  /** Stable fingerprint used to stop the machine repeating itself. */
  dedup_hash: string;
  qc: QcResult | null;
  scheduled_for: IsoDate | null;
  published_at: IsoDate | null;
  /** Set by the optimizer when this item exists because of a recommendation. */
  origin: 'initial' | 'autopilot' | 'optimizer' | 'manual' | 'trend';
  ai_cost_usd: number;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface CreativeAsset {
  id: Uuid;
  project_id: Uuid;
  content_item_id: Uuid | null;
  kind: 'image' | 'video' | 'carousel_slide' | 'thumbnail';
  /** `svg_render` assets are produced locally; `ai_image` needs a provider. */
  source: 'svg_render' | 'ai_image' | 'repo_screenshot' | 'video_render' | 'upload';
  mime_type: string;
  width: number;
  height: number;
  /** Publicly reachable URL. Required before a platform can pull the media. */
  url: string | null;
  storage_path: string | null;
  /** Inline SVG for locally rendered creative, so nothing is ever a stub. */
  svg: string | null;
  alt_text: string;
  created_at: IsoDate;
}

/* ── Quality control ────────────────────────────────────────────────────── */

export type QcSeverity = 'pass' | 'warn' | 'block';

export interface QcFinding {
  check: string;
  severity: QcSeverity;
  message: string;
  excerpt?: string;
}

export interface QcResult {
  passed: boolean;
  requires_human_review: boolean;
  score: number;
  findings: QcFinding[];
  checked_at: IsoDate;
}

/* ── Social accounts ────────────────────────────────────────────────────── */

export type ConnectionStatus =
  | 'connected'
  | 'expired'
  | 'revoked'
  | 'needs_setup'
  | 'error'
  | 'disconnected';

export interface SocialAccount {
  id: Uuid;
  project_id: Uuid;
  platform: Platform;
  /** Platform-side account id (IG user id, TikTok open_id). */
  external_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status: ConnectionStatus;
  status_detail: string | null;
  /** Capabilities the platform actually granted, verified at connect time. */
  granted_scopes: string[];
  /** e.g. TikTok privacy levels available to this creator. */
  platform_metadata: Record<string, unknown>;
  followers: number;
  last_checked_at: IsoDate | null;
  connected_at: IsoDate;
}

export interface OAuthToken {
  id: Uuid;
  social_account_id: Uuid;
  project_id: Uuid;
  /** AES-256-GCM ciphertext. Never returned to a client. */
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  expires_at: IsoDate | null;
  refresh_expires_at: IsoDate | null;
  scopes: string[];
  updated_at: IsoDate;
}

/* ── Scheduling & publishing ────────────────────────────────────────────── */

export interface ScheduledPost {
  id: Uuid;
  project_id: Uuid;
  content_item_id: Uuid;
  social_account_id: Uuid | null;
  platform: Platform;
  scheduled_for: IsoDate;
  timezone: string;
  status: ContentStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: IsoDate | null;
  created_at: IsoDate;
}

export interface PublishedPost {
  id: Uuid;
  project_id: Uuid;
  content_item_id: Uuid;
  scheduled_post_id: Uuid | null;
  social_account_id: Uuid;
  platform: Platform;
  /** Platform's own id for the published media. */
  external_id: string;
  permalink: string | null;
  published_at: IsoDate;
  /** Response the platform actually returned — the receipt for the publish. */
  platform_response: Record<string, unknown>;
}

/* ── Analytics ──────────────────────────────────────────────────────────── */

export interface PostMetrics {
  views: number;
  reach: number;
  impressions: number;
  watch_time_seconds: number;
  completion_rate: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  profile_visits: number;
  clicks: number;
  conversions: number;
  follows: number;
}

export interface AnalyticsSnapshot {
  id: Uuid;
  project_id: Uuid;
  published_post_id: Uuid | null;
  social_account_id: Uuid | null;
  platform: Platform;
  scope: 'post' | 'account';
  metrics: PostMetrics;
  /** True when the numbers came from the platform API, not an estimate. */
  from_platform_api: boolean;
  collected_at: IsoDate;
}

export interface SendScore {
  total: number;
  content: number;
  audience: number;
  engagement: number;
  consistency: number;
  conversion: number;
  drivers: { label: string; delta: number; detail: string }[];
  computed_at: IsoDate;
}

export interface Experiment {
  id: Uuid;
  project_id: Uuid;
  hypothesis: string;
  dimension: 'format' | 'hook' | 'pillar' | 'platform' | 'time' | 'cta';
  variant_a: string;
  variant_b: string;
  metric: keyof PostMetrics;
  a_samples: number;
  b_samples: number;
  a_mean: number;
  b_mean: number;
  lift: number;
  confident: boolean;
  status: 'running' | 'concluded' | 'inconclusive';
  conclusion: string | null;
  created_at: IsoDate;
  concluded_at: IsoDate | null;
}

export interface Recommendation {
  id: Uuid;
  project_id: Uuid;
  /** FullSend's own words. It has an opinion; it says it plainly. */
  statement: string;
  rationale: string;
  evidence: { label: string; value: string }[];
  action: RecommendationAction;
  confidence: number;
  status: 'proposed' | 'applied' | 'dismissed' | 'auto_applied';
  applied_at: IsoDate | null;
  created_at: IsoDate;
}

export type RecommendationAction =
  | { type: 'shift_mix'; from: PillarType; to: PillarType; points: number }
  | { type: 'increase_format'; platform: Platform; format: ContentFormat; per_week: number }
  | { type: 'shift_time'; platform: Platform; day: number; hour: number }
  | { type: 'favor_hook_style'; style: string }
  | { type: 'increase_platform_weight'; platform: Platform; points: number }
  | { type: 'generate_content'; count: number; brief: string };

/* ── Automation & ops ───────────────────────────────────────────────────── */

export type JobType =
  | 'analyze_repository'
  | 'generate_strategy'
  | 'generate_brand'
  | 'generate_content'
  | 'generate_creative'
  | 'quality_control'
  | 'schedule_content'
  | 'publish_post'
  | 'collect_analytics'
  | 'optimize'
  | 'daily_autopilot'
  | 'weekly_report'
  | 'refresh_tokens'
  | 'scan_trends';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface Job {
  id: Uuid;
  project_id: Uuid | null;
  type: JobType;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: IsoDate;
  locked_at: IsoDate | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface AutomationRun {
  id: Uuid;
  project_id: Uuid;
  kind: 'daily' | 'weekly' | 'manual';
  started_at: IsoDate;
  finished_at: IsoDate | null;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  steps: AutomationStep[];
  summary: string | null;
}

export interface AutomationStep {
  name: string;
  status: 'ok' | 'skipped' | 'failed';
  detail: string;
  duration_ms: number;
}

export interface AutomationError {
  id: Uuid;
  project_id: Uuid | null;
  automation_run_id: Uuid | null;
  scope: string;
  message: string;
  /** Actionable next step shown to the user. Never a silent failure. */
  remedy: string | null;
  fatal: boolean;
  resolved: boolean;
  created_at: IsoDate;
}

export interface Notification {
  id: Uuid;
  user_id: Uuid;
  project_id: Uuid | null;
  severity: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  action_label: string | null;
  action_href: string | null;
  read: boolean;
  created_at: IsoDate;
}

export interface AiUsageRecord {
  id: Uuid;
  project_id: Uuid | null;
  user_id: Uuid | null;
  campaign_id: Uuid | null;
  content_item_id: Uuid | null;
  provider: string;
  model: string;
  task: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cost_usd: number;
  cache_hit: boolean;
  created_at: IsoDate;
}

export interface AuditLogEntry {
  id: Uuid;
  user_id: Uuid | null;
  project_id: Uuid | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  created_at: IsoDate;
}

export interface WeeklyReport {
  id: Uuid;
  project_id: Uuid;
  week_start: IsoDate;
  week_end: IsoDate;
  total_posts: number;
  reach: number;
  engagement: number;
  followers_gained: number;
  clicks: number;
  conversions: number;
  best_post_id: Uuid | null;
  best_hook: string | null;
  best_format: ContentFormat | null;
  best_platform: Platform | null;
  biggest_learning: string;
  next_week_strategy: string;
  send_score: SendScore;
  created_at: IsoDate;
}

/* ── Billing & settings ─────────────────────────────────────────────────── */

export type PlanTier = 'free' | 'send' | 'full_send' | 'agency';

export interface Subscription {
  id: Uuid;
  user_id: Uuid;
  tier: PlanTier;
  status: 'active' | 'trialing' | 'past_due' | 'canceled';
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: IsoDate | null;
  created_at: IsoDate;
}

export interface PlanLimits {
  projects: number;
  posts_per_month: number;
  platforms: Platform[];
  autopilot_modes: AutopilotMode[];
  optimization: boolean;
}

export interface Settings {
  id: Uuid;
  project_id: Uuid;
  /** Content the machine may publish without a human touching it. */
  auto_publish_pillars: PillarType[];
  require_approval_for_promotion: boolean;
  daily_post_cap: number;
  quiet_hours: { start: number; end: number } | null;
  notify_email: boolean;
  trend_participation: boolean;
  updated_at: IsoDate;
}

export interface TrendSignal {
  id: Uuid;
  project_id: Uuid;
  platform: Platform;
  label: string;
  kind: 'topic' | 'format' | 'keyword' | 'conversation';
  /** Where the signal actually came from. Never invented. */
  source: 'platform_api' | 'repo_context' | 'category_pattern';
  relevance: number;
  can_participate: boolean;
  participation_angle: string | null;
  observed_at: IsoDate;
}
