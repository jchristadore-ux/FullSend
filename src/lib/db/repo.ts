import { newId, nowIso } from '../ids';
import { isStalled } from '../jobs/job-failure';
import type { AiUsageRecord, AnalyticsSnapshot, AuditLogEntry, AutomationError, AutomationRun, BrandProfile, Campaign, ContentItem, ContentPillar, ContentStatus, CreativeAsset, Job, JobType, MarketingStrategy, Notification, Persona, Platform, ProductAnalysis, Project, PublishedPost, Recommendation, Repository, ScheduledPost, Settings, SocialAccount, TrendSignal, User, Uuid, WeeklyReport } from '../types';
import { getStore, type Store, type TenantScope } from './index';

export function db(): Store { return getStore(); }
export async function upsertUser(scope: TenantScope, user: Omit<User, 'created_at'> & { created_at?: string }): Promise<User> { const existing = await db().get(scope, 'users', user.id); if (existing) return db().update(scope, 'users', user.id, { email: user.email, name: user.name, avatar_url: user.avatar_url, is_admin: user.is_admin }); return db().insert(scope, 'users', { ...user, created_at: user.created_at ?? nowIso() }); }
export async function listProjects(scope: TenantScope, userId?: Uuid): Promise<Project[]> { return db().find(scope, 'projects', { where: userId ? { user_id: userId } : undefined, orderBy: 'created_at', direction: 'desc' }); }
export async function getProject(scope: TenantScope, id: Uuid): Promise<Project | null> { return db().get(scope, 'projects', id); }
export async function updateProject(scope: TenantScope, id: Uuid, patch: Partial<Project>): Promise<Project> { return db().update(scope, 'projects', id, { ...patch, updated_at: nowIso() }); }
export async function getRepository(scope: TenantScope, projectId: Uuid): Promise<Repository | null> { return db().findOne(scope, 'repositories', { where: { project_id: projectId } }); }
export async function getAnalysis(scope: TenantScope, projectId: Uuid): Promise<ProductAnalysis | null> { return db().findOne(scope, 'product_analysis', { where: { project_id: projectId }, orderBy: 'created_at', direction: 'desc' }); }
export async function listPersonas(scope: TenantScope, projectId: Uuid): Promise<Persona[]> { return db().find(scope, 'personas', { where: { project_id: projectId }, orderBy: 'priority', direction: 'asc' }); }
export async function getStrategy(scope: TenantScope, projectId: Uuid): Promise<MarketingStrategy | null> { return db().findOne(scope, 'marketing_strategies', { where: { project_id: projectId }, orderBy: 'version', direction: 'desc' }); }
export async function getBrandProfile(scope: TenantScope, projectId: Uuid): Promise<BrandProfile | null> { return db().findOne(scope, 'brand_profiles', { where: { project_id: projectId } }); }
export async function listPillars(scope: TenantScope, projectId: Uuid): Promise<ContentPillar[]> { return db().find(scope, 'content_pillars', { where: { project_id: projectId } }); }
export async function listCampaigns(scope: TenantScope, projectId: Uuid): Promise<Campaign[]> { return db().find(scope, 'campaigns', { where: { project_id: projectId }, orderBy: 'starts_at', direction: 'asc' }); }
export async function listContent(scope: TenantScope, projectId: Uuid, opts: { status?: ContentStatus[]; platform?: Platform; limit?: number } = {}): Promise<ContentItem[]> { return db().find(scope, 'content_items', { where: { project_id: projectId, ...(opts.platform ? { platform: opts.platform } : {}) }, whereIn: opts.status ? { status: opts.status } : undefined, orderBy: 'scheduled_for', direction: 'asc', limit: opts.limit }); }
export async function listCreativeFor(scope: TenantScope, projectId: Uuid, contentItemId: Uuid): Promise<CreativeAsset[]> { return db().find(scope, 'creative_assets', { where: { project_id: projectId, content_item_id: contentItemId } }); }
export async function listSocialAccounts(scope: TenantScope, projectId: Uuid): Promise<SocialAccount[]> { return db().find(scope, 'social_accounts', { where: { project_id: projectId } }); }
export async function getSocialAccount(scope: TenantScope, projectId: Uuid, platform: Platform): Promise<SocialAccount | null> { return db().findOne(scope, 'social_accounts', { where: { project_id: projectId, platform } }); }
export async function listScheduled(scope: TenantScope, projectId: Uuid, opts: { from?: string; to?: string; status?: ContentStatus[] } = {}): Promise<ScheduledPost[]> { return db().find(scope, 'scheduled_posts', { where: { project_id: projectId }, whereIn: opts.status ? { status: opts.status } : undefined, gte: opts.from ? { scheduled_for: opts.from } : undefined, lt: opts.to ? { scheduled_for: opts.to } : undefined, orderBy: 'scheduled_for', direction: 'asc' }); }
export async function dueScheduledPosts(scope: TenantScope, now: string, limit = 50): Promise<ScheduledPost[]> { return db().find(scope, 'scheduled_posts', { whereIn: { status: ['scheduled', 'failed'] }, lt: { scheduled_for: now }, orderBy: 'scheduled_for', direction: 'asc', limit }); }
export async function listPublished(scope: TenantScope, projectId: Uuid, limit = 50): Promise<PublishedPost[]> { return db().find(scope, 'published_posts', { where: { project_id: projectId }, orderBy: 'published_at', direction: 'desc', limit }); }
export async function listAnalytics(scope: TenantScope, projectId: Uuid, opts: { since?: string; scopeKind?: 'post' | 'account' } = {}): Promise<AnalyticsSnapshot[]> { return db().find(scope, 'analytics', { where: { project_id: projectId, ...(opts.scopeKind ? { scope: opts.scopeKind } : {}) }, gte: opts.since ? { collected_at: opts.since } : undefined, orderBy: 'collected_at', direction: 'desc' }); }

export async function enqueue(scope: TenantScope, type: JobType, payload: Record<string, unknown>, opts: { projectId?: Uuid | null; runAfter?: string; maxAttempts?: number } = {}): Promise<Job> {
  const ts = nowIso();
  return db().insert(scope, 'jobs', { id: newId(), project_id: opts.projectId ?? null, type, payload, status: 'queued', attempts: 0, max_attempts: opts.maxAttempts ?? 5, run_after: opts.runAfter ?? ts, locked_at: null, last_error: null, result: null, created_at: ts, updated_at: ts });
}
const enqueueLocks = new Map<string, Promise<unknown>>();
export async function enqueueOnce(scope: TenantScope, type: JobType, payload: Record<string, unknown>, opts: { projectId?: Uuid | null; runAfter?: string; maxAttempts?: number; dedupeKey?: string } = {}): Promise<{ job: Job; created: boolean }> {
  const projectId = opts.projectId ?? null;
  if (!projectId) return { job: await enqueue(scope, type, payload, opts), created: true };
  const key = `${projectId}:${type}:${opts.dedupeKey ?? ''}`;
  const prior = enqueueLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  enqueueLocks.set(key, gate);
  await prior.catch(() => {});
  try {
    const open = await db().find(scope, 'jobs', { where: { project_id: projectId, type }, whereIn: { status: ['queued', 'running'] }, orderBy: 'created_at', direction: 'asc', limit: 50 });
    const live = open.find((j) => { if (isStalled({ status: j.status, lockedAt: j.locked_at, updatedAt: j.updated_at })) return false; if (!opts.dedupeKey) return true; return String(j.payload.idempotencyKey ?? '') === opts.dedupeKey; });
    if (live) return { job: live, created: false };
    return { job: await enqueue(scope, type, payload, opts), created: true };
  } finally { release(); if (enqueueLocks.get(key) === gate) enqueueLocks.delete(key); }
}

export async function recordError(scope: TenantScope, input: { projectId?: Uuid | null; runId?: Uuid | null; scope: string; message: string; remedy?: string | null; fatal?: boolean }): Promise<AutomationError> { return db().insert(scope, 'automation_errors', { id: newId(), project_id: input.projectId ?? null, automation_run_id: input.runId ?? null, scope: input.scope, message: input.message, remedy: input.remedy ?? null, fatal: input.fatal ?? false, resolved: false, created_at: nowIso() }); }
export async function notify(scope: TenantScope, input: Omit<Notification, 'id' | 'created_at' | 'read'>): Promise<Notification> { return db().insert(scope, 'notifications', { ...input, id: newId(), read: false, created_at: nowIso() }); }
export async function audit(scope: TenantScope, entry: Omit<AuditLogEntry, 'id' | 'created_at'>): Promise<AuditLogEntry> { return db().insert(scope, 'audit_log', { ...entry, id: newId(), created_at: nowIso() }); }
export async function recordAiUsage(scope: TenantScope, usage: Omit<AiUsageRecord, 'id' | 'created_at'>): Promise<AiUsageRecord> { return db().insert(scope, 'ai_usage', { ...usage, id: newId(), created_at: nowIso() }); }
export async function listRecommendations(scope: TenantScope, projectId: Uuid): Promise<Recommendation[]> { return db().find(scope, 'recommendations', { where: { project_id: projectId }, orderBy: 'created_at', direction: 'desc' }); }
export async function getSettings(scope: TenantScope, projectId: Uuid): Promise<Settings | null> { return db().findOne(scope, 'settings', { where: { project_id: projectId } }); }
export async function listAutomationRuns(scope: TenantScope, projectId: Uuid, limit = 20): Promise<AutomationRun[]> { return db().find(scope, 'automation_runs', { where: { project_id: projectId }, orderBy: 'started_at', direction: 'desc', limit }); }
export async function latestWeeklyReport(scope: TenantScope, projectId: Uuid): Promise<WeeklyReport | null> { return db().findOne(scope, 'weekly_reports', { where: { project_id: projectId }, orderBy: 'week_start', direction: 'desc' }); }
export async function listTrendSignals(scope: TenantScope, projectId: Uuid): Promise<TrendSignal[]> { return db().find(scope, 'trend_signals', { where: { project_id: projectId }, orderBy: 'observed_at', direction: 'desc', limit: 40 }); }
