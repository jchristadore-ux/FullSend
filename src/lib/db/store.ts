/**
 * The FullSend data layer.
 *
 * Every table lives behind one generic collection API. The important property
 * is that reads and writes are *always* tenant-scoped: a `TenantScope` is
 * required for anything project- or user-owned, and the store refuses to return
 * a row whose owner does not match. Supabase RLS enforces the same rule at the
 * database, so isolation holds even if application code has a bug.
 */

import type {
  AiUsageRecord,
  AnalyticsSnapshot,
  AuditLogEntry,
  AutomationError,
  AutomationRun,
  BrandProfile,
  Campaign,
  ContentItem,
  ContentPillar,
  CreativeAsset,
  Experiment,
  Job,
  MarketingStrategy,
  Notification,
  OAuthToken,
  Persona,
  ProductAnalysis,
  Project,
  PublishedPost,
  Recommendation,
  Repository,
  ScheduledPost,
  Settings,
  SocialAccount,
  Subscription,
  TrendSignal,
  User,
  Uuid,
  WeeklyReport,
} from '../types';

/** Every persisted collection. Names match the SQL tables one-for-one. */
export interface Tables {
  users: User;
  projects: Project;
  repositories: Repository;
  product_analysis: ProductAnalysis;
  personas: Persona;
  marketing_strategies: MarketingStrategy;
  brand_profiles: BrandProfile;
  content_pillars: ContentPillar;
  campaigns: Campaign;
  content_items: ContentItem;
  creative_assets: CreativeAsset;
  social_accounts: SocialAccount;
  oauth_tokens: OAuthToken;
  scheduled_posts: ScheduledPost;
  published_posts: PublishedPost;
  analytics: AnalyticsSnapshot;
  experiments: Experiment;
  recommendations: Recommendation;
  jobs: Job;
  automation_runs: AutomationRun;
  automation_errors: AutomationError;
  notifications: Notification;
  settings: Settings;
  subscriptions: Subscription;
  weekly_reports: WeeklyReport;
  ai_usage: AiUsageRecord;
  audit_log: AuditLogEntry;
  trend_signals: TrendSignal;
}

export type TableName = keyof Tables;

/**
 * Which column ties a row to a tenant. `project` rows are additionally checked
 * against project ownership, so a user can never read another user's project
 * data even if they guess a project id.
 */
export const TENANT_KEY: Record<TableName, 'user_id' | 'project_id' | 'none'> = {
  users: 'none',
  projects: 'user_id',
  repositories: 'project_id',
  product_analysis: 'project_id',
  personas: 'project_id',
  marketing_strategies: 'project_id',
  brand_profiles: 'project_id',
  content_pillars: 'project_id',
  campaigns: 'project_id',
  content_items: 'project_id',
  creative_assets: 'project_id',
  social_accounts: 'project_id',
  oauth_tokens: 'project_id',
  scheduled_posts: 'project_id',
  published_posts: 'project_id',
  analytics: 'project_id',
  experiments: 'project_id',
  recommendations: 'project_id',
  jobs: 'project_id',
  automation_runs: 'project_id',
  automation_errors: 'project_id',
  notifications: 'user_id',
  settings: 'project_id',
  subscriptions: 'user_id',
  weekly_reports: 'project_id',
  ai_usage: 'project_id',
  audit_log: 'user_id',
  trend_signals: 'project_id',
};

/**
 * Identifies who is asking. `system` is only ever constructed server-side by
 * background jobs, which legitimately act across tenants.
 */
export type TenantScope =
  | { kind: 'user'; userId: Uuid }
  | { kind: 'system'; reason: string };

export function userScope(userId: Uuid): TenantScope {
  return { kind: 'user', userId };
}

export function systemScope(reason: string): TenantScope {
  return { kind: 'system', reason };
}

export type Filter<T> = Partial<Record<keyof T, unknown>>;

export interface QueryOptions<T> {
  where?: Filter<T>;
  /** Rows whose column is in the given set. */
  whereIn?: Partial<Record<keyof T, unknown[]>>;
  /** Inclusive lower / exclusive upper bounds, for time-window queries. */
  gte?: Partial<Record<keyof T, string | number>>;
  lt?: Partial<Record<keyof T, string | number>>;
  orderBy?: keyof T;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/** Bounds on which job a worker pass is allowed to take. */
export interface ClaimOptions {
  projectId?: Uuid | null;
  /** Only claim jobs created at or before this instant. */
  createdBefore?: string | null;
}

export interface Store {
  insert<K extends TableName>(scope: TenantScope, table: K, row: Tables[K]): Promise<Tables[K]>;
  insertMany<K extends TableName>(
    scope: TenantScope,
    table: K,
    rows: Tables[K][],
  ): Promise<Tables[K][]>;
  get<K extends TableName>(scope: TenantScope, table: K, id: Uuid): Promise<Tables[K] | null>;
  find<K extends TableName>(
    scope: TenantScope,
    table: K,
    options?: QueryOptions<Tables[K]>,
  ): Promise<Tables[K][]>;
  findOne<K extends TableName>(
    scope: TenantScope,
    table: K,
    options?: QueryOptions<Tables[K]>,
  ): Promise<Tables[K] | null>;
  update<K extends TableName>(
    scope: TenantScope,
    table: K,
    id: Uuid,
    patch: Partial<Tables[K]>,
  ): Promise<Tables[K]>;
  remove<K extends TableName>(scope: TenantScope, table: K, id: Uuid): Promise<void>;
  count<K extends TableName>(
    scope: TenantScope,
    table: K,
    options?: QueryOptions<Tables[K]>,
  ): Promise<number>;

  /** Ids of projects the scope may touch. Used to constrain project-keyed reads. */
  accessibleProjectIds(scope: TenantScope): Promise<Uuid[] | 'all'>;

  /**
   * Claims the next runnable job atomically. Two workers must never get the
   * same job — the Supabase driver does this with a conditional update.
   *
   * `createdBefore` bounds the claim to jobs that already existed at a given
   * instant. A worker pass uses it so the successor a job enqueues is left for
   * the next pass rather than followed inside this one, which is what keeps a
   * four-stage AI chain from running end-to-end in a single invocation.
   */
  claimNextJob(
    now: string,
    lockTimeoutMs: number,
    opts?: ClaimOptions,
  ): Promise<Job | null>;

  reset?(): Promise<void>;
}
