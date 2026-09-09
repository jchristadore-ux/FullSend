-- Website URL as a product source, alongside GitHub.
--
-- A project can be grounded in a public website instead of a repository. The
-- source discriminator lives on the project so existing GitHub rows need no
-- rewrite; website_url is null for them. Product analysis no longer requires a
-- repository row — website analyses cite fetched pages instead of commits.

alter table public.projects
  add column if not exists source_type text not null default 'github',
  add column if not exists website_url text;

alter table public.projects
  drop constraint if exists projects_source_type_check;
alter table public.projects
  add constraint projects_source_type_check
  check (source_type in ('github', 'website'));

-- A website project must carry a URL; a GitHub project must not pretend to.
alter table public.projects
  drop constraint if exists projects_source_fields_check;
alter table public.projects
  add constraint projects_source_fields_check
  check (
    (source_type = 'github' and website_url is null)
    or (source_type = 'website' and website_url is not null)
  );

create index if not exists projects_website_url_idx
  on public.projects (user_id, website_url)
  where source_type = 'website';

-- Snapshot of the last successful website fetch for a project. Mirrors the
-- role repositories play for GitHub: resume, re-analysis identity, and a place
-- to hang the raw signals without bloating the analysis row alone.
create table if not exists public.website_sources (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  url text not null,
  final_url text,
  title text,
  content_hash text,
  signals jsonb not null default '{}'::jsonb,
  last_fetched_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists website_sources_project_idx on public.website_sources(project_id);

alter table public.website_sources enable row level security;
alter table public.website_sources force row level security;

drop policy if exists website_sources_tenant on public.website_sources;
create policy website_sources_tenant on public.website_sources
  for all
  using (public.owns_project(project_id))
  with check (public.owns_project(project_id));

-- Website analyses have no repository. Existing rows keep their FK.
alter table public.product_analysis
  alter column repository_id drop not null;

alter table public.product_analysis
  drop constraint if exists product_analysis_repository_id_fkey;
alter table public.product_analysis
  add constraint product_analysis_repository_id_fkey
  foreign key (repository_id) references public.repositories(id) on delete set null;
