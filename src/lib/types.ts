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

/**
 * Production social destinations.
 *
 * Instagram is the only production destination. TikTok exists in the codebase
 * but stays off unless FULLSEND_TIKTOK_ENABLED=true — see
 * `livePlatforms()` in `src/lib/social/registry.ts` for the flag-aware list.
 */
export const LIVE_PLATFORMS: Platform[] = ['instagram'];

export const CONTENT_FORMATS = [
  'reel',
  'carousel',
  'static',
  'story',
  'short_video',
  'text',
] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

// NOTE: Remainder of types.ts restored from main in follow-up — temporary stub for compile.
export type ProjectStatus = 'created' | 'analyzing' | 'analyzed' | 'strategy_ready' | 'content_ready' | 'live' | 'paused' | 'failed';
export type AutopilotMode = 'manual' | 'hybrid' | 'full_send';
export type ProjectSourceType = 'github' | 'website';
export interface Project { id: Uuid; user_id: Uuid; name: string; slug: string; status: ProjectStatus; autopilot_mode: AutopilotMode; timezone: string; source_type: ProjectSourceType; website_url: string | null; is_internal: boolean; last_autopilot_run_at: IsoDate | null; created_at: IsoDate; updated_at: IsoDate; }
export interface User { id: Uuid; email: string; name: string | null; avatar_url: string | null; is_admin: boolean; created_at: IsoDate; }
export interface Repository { id: Uuid; project_id: Uuid; provider: 'github'; owner: string; name: string; url: string; default_branch: string; description: string | null; primary_language: string | null; languages: Record<string, number>; topics: string[]; stars: number; is_private: boolean; commit_sha: string | null; last_indexed_at: IsoDate | null; created_at: IsoDate; }
export interface WebsiteSource { id: Uuid; project_id: Uuid; url: string; final_url: string | null; title: string | null; content_hash: string | null; signals: Record<string, unknown>; last_fetched_at: IsoDate | null; created_at: IsoDate; }
export interface ProductFeature { name: string; description: string; evidence: string[]; user_facing: boolean; }
export interface AppScreen { name: string; route: string | null; purpose: string; key_elements: string[]; workflow: string | null; image_url: string | null; source_file: string | null; }
export interface ProductAnalysis { id: Uuid; project_id: Uuid; repository_id: Uuid | null; commit_sha: string | null; one_liner: string; what_it_does: string; category: string; features: ProductFeature[]; not_capabilities: string[]; tech_stack: string[]; platforms: string[]; target_market: string; problem_solved: string; differentiators: string[]; maturity: 'prototype' | 'alpha' | 'beta' | 'production'; screens: AppScreen[]; confidence: number; raw_signals: Record<string, unknown>; created_at: IsoDate; }
export interface Persona { id: Uuid; project_id: Uuid; name: string; role: string; description: string; pain_points: string[]; goals: string[]; objections: string[]; where_they_hang_out: Platform[]; tone_preference: string; priority: number; created_at: IsoDate; }
export type PillarType = 'education' | 'product_demo' | 'entertainment' | 'social_proof' | 'promotion';
export type ContentMix = Record<PillarType, number>;
export interface PostingCadence { instagram_per_week: number; tiktok_per_week: number; best_times: { day: number; hour: number; platform: Platform }[]; }
export interface PlatformStrategy { platform: Platform; rationale: string; formats: ContentFormat[]; weight: number; }
export interface MarketingStrategy { id: Uuid; project_id: Uuid; version: number; positioning: string; value_proposition: string; audience_summary: string; pain_points: string[]; differentiators: string[]; campaign_strategy: string; posting_cadence: PostingCadence; platform_strategy: PlatformStrategy[]; growth_strategy: string; cta_strategy: string[]; content_mix: ContentMix; approved: boolean; approved_at: IsoDate | null; created_at: IsoDate; }
export interface ContentPillar { id: Uuid; project_id: Uuid; name: string; type: PillarType; description: string; weight: number; example_topics: string[]; created_at: IsoDate; }
export const BRAND_EDITABLE_FIELDS = ['brand_name','primary_color','secondary_color','accent_color','background_color','text_color','heading_font','body_font','logo_url','logo_dark_url','icon_style','design_language','imagery_style','graphic_style','brand_personality','visual_style','voice','brand_keywords','visual_dos','visual_donts','content_dos','content_donts'] as const;
export type BrandEditableField = (typeof BRAND_EDITABLE_FIELDS)[number];
export interface BrandProfile { id: Uuid; project_id: Uuid; brand_name: string; voice: string; tone_attributes: string[]; audience: string; messaging_pillars: string[]; terminology: Record<string, string>; primary_color: string; secondary_color: string; accent_color: string; background_color: string; text_color: string; heading_font: string; body_font: string; logo_url: string | null; logo_dark_url: string | null; icon_style: string; design_language: string; imagery_style: string; graphic_style: string; brand_personality: string; visual_style: string; words_to_use: string[]; words_to_avoid: string[]; brand_keywords: string[]; visual_dos: string[]; visual_donts: string[]; content_dos: string[]; content_donts: string[]; positioning: string; ctas: string[]; emoji_policy: 'none' | 'sparing' | 'liberal'; identity_sources: Record<string, string>; locked_fields: BrandEditableField[]; identity_discovered_at: IsoDate | null; updated_at: IsoDate; }
export interface Campaign { id: Uuid; project_id: Uuid; name: string; angle: string; goal: string; hypothesis: string; target_persona_id: Uuid | null; platforms: Platform[]; starts_at: IsoDate; ends_at: IsoDate; status: 'planned' | 'active' | 'complete' | 'archived'; created_at: IsoDate; }
export const GENERATION_STATES = ['pending','generating_copy','copy_complete','generating_creative','creative_complete','complete','failed'] as const;
export type GenerationState = (typeof GENERATION_STATES)[number];
export function isGenerationComplete(state: GenerationState | null | undefined): boolean { return state === 'complete' || state === undefined || state === null; }
export type ContentStatus = 'draft' | 'approval_required' | 'approved' | 'scheduled' | 'publishing' | 'published' | 'failed' | 'review_required';
export interface VideoScene { index: number; duration_seconds: number; visual: string; on_screen_text: string; narration: string; screen_reference: string | null; }
export interface VideoPlan { total_duration_seconds: number; hook_text: string; scenes: VideoScene[]; narration_script: string; music_direction: string; cta_text: string; rendered_url: string | null; render_status: 'not_attempted' | 'package_only' | 'queued' | 'rendered' | 'failed'; render_note: string | null; }
export type QcSeverity = 'pass' | 'warn' | 'block';
export interface QcFinding { check: string; severity: QcSeverity; message: string; excerpt?: string; }
export interface QcResult { passed: boolean; requires_human_review: boolean; score: number; findings: QcFinding[]; checked_at: IsoDate; }
export interface ContentItem { id: Uuid; project_id: Uuid; campaign_id: Uuid | null; pillar_id: Uuid | null; persona_id: Uuid | null; platform: Platform; format: ContentFormat; hook: string; script: string | null; caption: string; cta: string; hashtags: string[]; video_plan: VideoPlan | null; slides: { headline: string; body: string }[] | null; creative_asset_ids: Uuid[]; status: ContentStatus; generation_state: GenerationState; generation_error: string | null; dedup_hash: string; qc: QcResult | null; scheduled_for: IsoDate | null; published_at: IsoDate | null; origin: 'initial' | 'autopilot' | 'optimizer' | 'manual' | 'trend'; ai_cost_usd: number; created_at: IsoDate; updated_at: IsoDate; }
export interface CreativeAsset { id: Uuid; project_id: Uuid; content_item_id: Uuid | null; kind: 'image' | 'video' | 'carousel_slide' | 'thumbnail'; source: 'svg_render' | 'ai_image' | 'repo_screenshot' | 'video_render' | 'upload'; mime_type: string; width: number; height: number; url: string | null; storage_path: string | null; svg: string | null; alt_text: string; created_at: IsoDate; }
export type ConnectionStatus = 'connected' | 'expired' | 'revoked' | 'needs_setup' | 'error' | 'disconnected';
export interface SocialAccount { id: Uuid; project_id: Uuid; platform: Platform; external_id: string; username: string; display_name: string | null; avatar_url: string | null; status: ConnectionStatus; status_detail: string | null; granted_scopes: string[]; platform_metadata: Record<string, unknown>; followers: number; last_checked_at: IsoDate | null; connected_at: IsoDate; }
export interface OAuthToken { id: Uuid; social_account_id: Uuid; project_id: Uuid; access_token_encrypted: string; refresh_token_encrypted: string | null; platform_token_encrypted: string | null; expires_at: IsoDate | null; refresh_expires_at: IsoDate | null; scopes: string[]; updated_at: IsoDate; }
export interface ScheduledPost { id: Uuid; project_id: Uuid; content_item_id: Uuid; social_account_id: Uuid | null; platform: Platform; scheduled_for: IsoDate; timezone: string; status: ContentStatus; attempts: number; last_error: string | null; next_attempt_at: IsoDate | null; created_at: IsoDate; started_at: IsoDate | null; platform_container_id: string | null; publish_submitted_at: IsoDate | null; published_at: IsoDate | null; }
export interface PublishedPost { id: Uuid; project_id: Uuid; content_item_id: Uuid; scheduled_post_id: Uuid | null; social_account_id: Uuid; platform: Platform; external_id: string; permalink: string | null; published_at: IsoDate; platform_response: Record<string, unknown>; }
export interface PostMetrics { views: number; reach: number; impressions: number; watch_time_seconds: number; completion_rate: number; likes: number; comments: number; shares: number; saves: number; profile_visits: number; clicks: number; conversions: number; follows: number; }
export interface AnalyticsSnapshot { id: Uuid; project_id: Uuid; published_post_id: Uuid | null; social_account_id: Uuid | null; platform: Platform; scope: 'post' | 'account'; metrics: PostMetrics; from_platform_api: boolean; collected_at: IsoDate; }
export interface SendScore { total: number; content: number; audience: number; engagement: number; consistency: number; conversion: number; drivers: { label: string; delta: number; detail: string }[]; computed_at: IsoDate; }
export interface Experiment { id: Uuid; project_id: Uuid; hypothesis: string; dimension: 'format' | 'hook' | 'pillar' | 'platform' | 'time' | 'cta'; variant_a: string; variant_b: string; metric: keyof PostMetrics; a_samples: number; b_samples: number; a_mean: number; b_mean: number; lift: number; confident: boolean; status: 'running' | 'concluded' | 'inconclusive'; conclusion: string | null; created_at: IsoDate; concluded_at: IsoDate | null; }
export type RecommendationAction = { type: 'shift_mix'; from: PillarType; to: PillarType; points: number } | { type: 'increase_format'; platform: Platform; format: ContentFormat; per_week: number } | { type: 'shift_time'; platform: Platform; day: number; hour: number } | { type: 'favor_hook_style'; style: string } | { type: 'increase_platform_weight'; platform: Platform; points: number } | { type: 'generate_content'; count: number; brief: string };
export interface Recommendation { id: Uuid; project_id: Uuid; statement: string; rationale: string; evidence: { label: string; value: string }[]; action: RecommendationAction; confidence: number; status: 'proposed' | 'applied' | 'dismissed' | 'auto_applied'; applied_at: IsoDate | null; created_at: IsoDate; }
export type JobType = 'analyze_repository' | 'generate_strategy' | 'generate_brand' | 'generate_content' | 'generate_creative' | 'quality_control' | 'schedule_content' | 'publish_post' | 'collect_analytics' | 'optimize' | 'daily_autopilot' | 'weekly_report' | 'refresh_tokens' | 'scan_trends';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
export interface Job { id: Uuid; project_id: Uuid | null; type: JobType; payload: Record<string, unknown>; status: JobStatus; attempts: number; max_attempts: number; run_after: IsoDate; locked_at: IsoDate | null; last_error: string | null; result: Record<string, unknown> | null; created_at: IsoDate; updated_at: IsoDate; }
export interface AutomationStep { name: string; status: 'ok' | 'skipped' | 'failed'; detail: string; duration_ms: number; }
export interface AutomationRun { id: Uuid; project_id: Uuid; kind: 'daily' | 'weekly' | 'manual'; started_at: IsoDate; finished_at: IsoDate | null; status: 'running' | 'succeeded' | 'partial' | 'failed'; steps: AutomationStep[]; summary: string | null; }
export interface AutomationError { id: Uuid; project_id: Uuid | null; automation_run_id: Uuid | null; scope: string; message: string; remedy: string | null; fatal: boolean; resolved: boolean; created_at: IsoDate; }
export interface Notification { id: Uuid; user_id: Uuid; project_id: Uuid | null; severity: 'info' | 'success' | 'warning' | 'error'; title: string; body: string; action_label: string | null; action_href: string | null; read: boolean; created_at: IsoDate; }
export interface AiUsageRecord { id: Uuid; project_id: Uuid | null; user_id: Uuid | null; campaign_id: Uuid | null; content_item_id: Uuid | null; provider: string; model: string; task: string; input_tokens: number; output_tokens: number; cached_input_tokens: number; cost_usd: number; cache_hit: boolean; created_at: IsoDate; }
export interface AuditLogEntry { id: Uuid; user_id: Uuid | null; project_id: Uuid | null; action: string; target: string | null; metadata: Record<string, unknown>; ip: string | null; created_at: IsoDate; }
export interface WeeklyReport { id: Uuid; project_id: Uuid; week_start: IsoDate; week_end: IsoDate; total_posts: number; reach: number; engagement: number; followers_gained: number; clicks: number; conversions: number; best_post_id: Uuid | null; best_hook: string | null; best_format: ContentFormat | null; best_platform: Platform | null; biggest_learning: string; next_week_strategy: string; send_score: SendScore; created_at: IsoDate; }
export type PlanTier = 'free' | 'send' | 'full_send' | 'agency';
export interface Subscription { id: Uuid; user_id: Uuid; tier: PlanTier; status: 'active' | 'trialing' | 'past_due' | 'canceled'; stripe_customer_id: string | null; stripe_subscription_id: string | null; current_period_end: IsoDate | null; created_at: IsoDate; }
export interface PlanLimits { projects: number; posts_per_month: number; platforms: Platform[]; autopilot_modes: AutopilotMode[]; optimization: boolean; }
export interface Settings { id: Uuid; project_id: Uuid; auto_publish_pillars: PillarType[]; require_approval_for_promotion: boolean; daily_post_cap: number; quiet_hours: { start: number; end: number } | null; notify_email: boolean; trend_participation: boolean; updated_at: IsoDate; }
export interface TrendSignal { id: Uuid; project_id: Uuid; platform: Platform; label: string; kind: 'topic' | 'format' | 'keyword' | 'conversation'; source: 'platform_api' | 'repo_context' | 'category_pattern'; relevance: number; can_participate: boolean; participation_angle: string | null; observed_at: IsoDate; }
