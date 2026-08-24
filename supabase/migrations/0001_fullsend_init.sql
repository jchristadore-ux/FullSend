-- FullSend — initial schema.
--
-- Tenancy model: every row hangs off a project, and every project hangs off a
-- user. RLS policies below let a signed-in user reach exactly their own rows.
-- Background jobs use the service-role key and bypass RLS deliberately; the
-- application store applies the same predicate in that path.

create extension if not exists "pgcrypto";

-- ── Users ─────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text,
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- ── Projects ──────────────────────────────────────────────────────────────
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  slug text not null,
  status text not null default 'created',
  autopilot_mode text not null default 'full_send'
    check (autopilot_mode in ('manual','hybrid','full_send')),
  timezone text not null default 'UTC',
  is_internal boolean not null default false,
  last_autopilot_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, slug)
);
create index if not exists projects_user_idx on public.projects(user_id);

-- ── Repositories & product understanding ──────────────────────────────────
create table if not exists public.repositories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  provider text not null default 'github',
  owner text not null,
  name text not null,
  url text not null,
  default_branch text not null default 'main',
  description text,
  primary_language text,
  languages jsonb not null default '{}'::jsonb,
  topics jsonb not null default '[]'::jsonb,
  stars integer not null default 0,
  is_private boolean not null default false,
  last_indexed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists repositories_project_idx on public.repositories(project_id);

create table if not exists public.product_analysis (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  repository_id uuid not null references public.repositories(id) on delete cascade,
  one_liner text not null,
  what_it_does text not null,
  category text not null,
  features jsonb not null default '[]'::jsonb,
  not_capabilities jsonb not null default '[]'::jsonb,
  tech_stack jsonb not null default '[]'::jsonb,
  platforms jsonb not null default '[]'::jsonb,
  target_market text not null default '',
  problem_solved text not null default '',
  differentiators jsonb not null default '[]'::jsonb,
  maturity text not null default 'beta',
  screens jsonb not null default '[]'::jsonb,
  confidence numeric not null default 0.5,
  raw_signals jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists product_analysis_project_idx on public.product_analysis(project_id);

create table if not exists public.personas (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  role text not null default '',
  description text not null default '',
  pain_points jsonb not null default '[]'::jsonb,
  goals jsonb not null default '[]'::jsonb,
  objections jsonb not null default '[]'::jsonb,
  where_they_hang_out jsonb not null default '[]'::jsonb,
  tone_preference text not null default '',
  priority integer not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists personas_project_idx on public.personas(project_id);

-- ── Strategy & brand ──────────────────────────────────────────────────────
create table if not exists public.marketing_strategies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version integer not null default 1,
  positioning text not null default '',
  value_proposition text not null default '',
  audience_summary text not null default '',
  pain_points jsonb not null default '[]'::jsonb,
  differentiators jsonb not null default '[]'::jsonb,
  campaign_strategy text not null default '',
  posting_cadence jsonb not null default '{}'::jsonb,
  platform_strategy jsonb not null default '[]'::jsonb,
  growth_strategy text not null default '',
  cta_strategy jsonb not null default '[]'::jsonb,
  content_mix jsonb not null default '{}'::jsonb,
  approved boolean not null default false,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);
create index if not exists strategies_project_idx on public.marketing_strategies(project_id);

create table if not exists public.brand_profiles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  voice text not null default '',
  tone_attributes jsonb not null default '[]'::jsonb,
  audience text not null default '',
  messaging_pillars jsonb not null default '[]'::jsonb,
  terminology jsonb not null default '{}'::jsonb,
  primary_color text not null default '#FF5A1F',
  secondary_color text not null default '#FFFFFF',
  background_color text not null default '#08090A',
  visual_style text not null default '',
  words_to_use jsonb not null default '[]'::jsonb,
  words_to_avoid jsonb not null default '[]'::jsonb,
  positioning text not null default '',
  ctas jsonb not null default '[]'::jsonb,
  emoji_policy text not null default 'sparing',
  updated_at timestamptz not null default now()
);

create table if not exists public.content_pillars (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  type text not null check (type in
    ('education','product_demo','entertainment','social_proof','promotion')),
  description text not null default '',
  weight numeric not null default 20,
  example_topics jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pillars_project_idx on public.content_pillars(project_id);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  angle text not null default '',
  goal text not null default '',
  hypothesis text not null default '',
  target_persona_id uuid references public.personas(id) on delete set null,
  platforms jsonb not null default '[]'::jsonb,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'planned',
  created_at timestamptz not null default now()
);
create index if not exists campaigns_project_idx on public.campaigns(project_id);

-- ── Content ───────────────────────────────────────────────────────────────
create table if not exists public.content_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  pillar_id uuid references public.content_pillars(id) on delete set null,
  persona_id uuid references public.personas(id) on delete set null,
  platform text not null,
  format text not null,
  hook text not null,
  script text,
  caption text not null,
  cta text not null default '',
  hashtags jsonb not null default '[]'::jsonb,
  video_plan jsonb,
  slides jsonb,
  creative_asset_ids jsonb not null default '[]'::jsonb,
  status text not null default 'draft',
  dedup_hash text not null,
  qc jsonb,
  scheduled_for timestamptz,
  published_at timestamptz,
  origin text not null default 'initial',
  ai_cost_usd numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_project_idx on public.content_items(project_id);
create index if not exists content_status_idx on public.content_items(project_id, status);
-- The machine must not repeat itself: one fingerprint per project.
create unique index if not exists content_dedup_idx
  on public.content_items(project_id, dedup_hash);

create table if not exists public.creative_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  content_item_id uuid references public.content_items(id) on delete cascade,
  kind text not null,
  source text not null,
  mime_type text not null default 'image/svg+xml',
  width integer not null default 1080,
  height integer not null default 1350,
  url text,
  storage_path text,
  svg text,
  alt_text text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists creative_project_idx on public.creative_assets(project_id);

-- ── Social accounts & tokens ──────────────────────────────────────────────
create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  platform text not null,
  external_id text not null,
  username text not null default '',
  display_name text,
  avatar_url text,
  status text not null default 'connected',
  status_detail text,
  granted_scopes jsonb not null default '[]'::jsonb,
  platform_metadata jsonb not null default '{}'::jsonb,
  followers integer not null default 0,
  last_checked_at timestamptz,
  connected_at timestamptz not null default now(),
  unique (project_id, platform)
);
create index if not exists social_project_idx on public.social_accounts(project_id);

-- Tokens are stored as AES-256-GCM ciphertext produced by the application.
-- No policy grants a client read access to this table at all.
create table if not exists public.oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  social_account_id uuid not null unique
    references public.social_accounts(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  expires_at timestamptz,
  refresh_expires_at timestamptz,
  scopes jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Scheduling & publishing ───────────────────────────────────────────────
create table if not exists public.scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  social_account_id uuid references public.social_accounts(id) on delete set null,
  platform text not null,
  scheduled_for timestamptz not null,
  timezone text not null default 'UTC',
  status text not null default 'scheduled',
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists scheduled_due_idx
  on public.scheduled_posts(status, scheduled_for);
create index if not exists scheduled_project_idx on public.scheduled_posts(project_id);

create table if not exists public.published_posts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  content_item_id uuid not null references public.content_items(id) on delete cascade,
  scheduled_post_id uuid references public.scheduled_posts(id) on delete set null,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  platform text not null,
  external_id text not null,
  permalink text,
  published_at timestamptz not null default now(),
  platform_response jsonb not null default '{}'::jsonb,
  unique (platform, external_id)
);
create index if not exists published_project_idx on public.published_posts(project_id);

-- ── Analytics & optimization ──────────────────────────────────────────────
create table if not exists public.analytics (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  published_post_id uuid references public.published_posts(id) on delete cascade,
  social_account_id uuid references public.social_accounts(id) on delete cascade,
  platform text not null,
  scope text not null check (scope in ('post','account')),
  metrics jsonb not null default '{}'::jsonb,
  from_platform_api boolean not null default true,
  collected_at timestamptz not null default now()
);
create index if not exists analytics_project_idx on public.analytics(project_id, collected_at);

create table if not exists public.experiments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  hypothesis text not null,
  dimension text not null,
  variant_a text not null,
  variant_b text not null,
  metric text not null,
  a_samples integer not null default 0,
  b_samples integer not null default 0,
  a_mean numeric not null default 0,
  b_mean numeric not null default 0,
  lift numeric not null default 0,
  confident boolean not null default false,
  status text not null default 'running',
  conclusion text,
  created_at timestamptz not null default now(),
  concluded_at timestamptz
);
create index if not exists experiments_project_idx on public.experiments(project_id);

create table if not exists public.recommendations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  statement text not null,
  rationale text not null default '',
  evidence jsonb not null default '[]'::jsonb,
  action jsonb not null,
  confidence numeric not null default 0.5,
  status text not null default 'proposed',
  applied_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists recommendations_project_idx on public.recommendations(project_id);

create table if not exists public.trend_signals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  platform text not null,
  label text not null,
  kind text not null,
  source text not null,
  relevance numeric not null default 0,
  can_participate boolean not null default false,
  participation_angle text,
  observed_at timestamptz not null default now()
);
create index if not exists trends_project_idx on public.trend_signals(project_id);

-- ── Automation & ops ──────────────────────────────────────────────────────
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jobs_claim_idx on public.jobs(status, run_after);

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kind text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  steps jsonb not null default '[]'::jsonb,
  summary text
);
create index if not exists runs_project_idx on public.automation_runs(project_id, started_at);

create table if not exists public.automation_errors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  automation_run_id uuid references public.automation_runs(id) on delete set null,
  scope text not null,
  message text not null,
  remedy text,
  fatal boolean not null default false,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists errors_project_idx on public.automation_errors(project_id, resolved);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  severity text not null default 'info',
  title text not null,
  body text not null default '',
  action_label text,
  action_href text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications(user_id, read);

create table if not exists public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  week_start date not null,
  week_end date not null,
  total_posts integer not null default 0,
  reach integer not null default 0,
  engagement integer not null default 0,
  followers_gained integer not null default 0,
  clicks integer not null default 0,
  conversions integer not null default 0,
  best_post_id uuid references public.published_posts(id) on delete set null,
  best_hook text,
  best_format text,
  best_platform text,
  biggest_learning text not null default '',
  next_week_strategy text not null default '',
  send_score jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, week_start)
);

create table if not exists public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  content_item_id uuid references public.content_items(id) on delete set null,
  provider text not null,
  model text not null,
  task text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  cost_usd numeric not null default 0,
  cache_hit boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_project_idx on public.ai_usage(project_id, created_at);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null,
  project_id uuid references public.projects(id) on delete cascade,
  action text not null,
  target text,
  metadata jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists audit_user_idx on public.audit_log(user_id, created_at);

create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  auto_publish_pillars jsonb not null default '[]'::jsonb,
  require_approval_for_promotion boolean not null default true,
  daily_post_cap integer not null default 3,
  quiet_hours jsonb,
  notify_email boolean not null default true,
  trend_participation boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  tier text not null default 'free',
  status text not null default 'active',
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);

-- ── Row level security ────────────────────────────────────────────────────
-- Every table is locked down. `owns_project` is the single predicate the
-- project-scoped policies share.

create or replace function public.owns_project(p uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects
    where id = p and user_id = auth.uid()
  );
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'users','projects','repositories','product_analysis','personas',
    'marketing_strategies','brand_profiles','content_pillars','campaigns',
    'content_items','creative_assets','social_accounts','oauth_tokens',
    'scheduled_posts','published_posts','analytics','experiments',
    'recommendations','trend_signals','jobs','automation_runs',
    'automation_errors','notifications','weekly_reports','ai_usage',
    'audit_log','settings','subscriptions'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- users: you are only ever yourself.
drop policy if exists users_self on public.users;
create policy users_self on public.users
  for all using (id = auth.uid()) with check (id = auth.uid());

-- projects: owned directly.
drop policy if exists projects_own on public.projects;
create policy projects_own on public.projects
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- user-keyed tables.
drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists subscriptions_own on public.subscriptions;
create policy subscriptions_own on public.subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists audit_own on public.audit_log;
create policy audit_own on public.audit_log
  for select using (user_id = auth.uid());

-- project-keyed tables: read/write only through a project you own.
do $$
declare t text;
begin
  foreach t in array array[
    'repositories','product_analysis','personas','marketing_strategies',
    'brand_profiles','content_pillars','campaigns','content_items',
    'creative_assets','social_accounts','scheduled_posts','published_posts',
    'analytics','experiments','recommendations','trend_signals',
    'automation_runs','automation_errors','weekly_reports','ai_usage','settings'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_tenant', t);
    execute format(
      'create policy %I on public.%I for all
         using (public.owns_project(project_id))
         with check (public.owns_project(project_id))',
      t || '_tenant', t);
  end loop;
end $$;

-- oauth_tokens and jobs: service-role only. No client policy exists, so with
-- RLS forced on, an anon/authenticated client can read neither.
-- (Deliberately left with zero policies.)

-- ── Auth trigger: mirror auth.users into public.users ─────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
