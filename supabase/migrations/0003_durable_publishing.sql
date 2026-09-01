-- Durable publishing.
--
-- Instagram publishes in two calls: create a media container, then publish it.
-- When the second call's response is lost — a timeout, a killed function, a
-- dead worker — the post can be live on Instagram with nothing on this side
-- saying so, and a blind retry publishes it a second time.
--
-- These columns are the record of an attempt in flight. The container id is
-- written before the publish call and the submission timestamp immediately
-- before it goes out, so the publisher can ask Instagram what actually
-- happened instead of guessing.

alter table public.scheduled_posts
  add column if not exists started_at timestamptz,
  add column if not exists platform_container_id text,
  add column if not exists publish_submitted_at timestamptz,
  add column if not exists published_at timestamptz;

-- Backfill: anything already published has a receipt to take the time from.
update public.scheduled_posts s
   set published_at = p.published_at
  from public.published_posts p
 where p.scheduled_post_id = s.id
   and s.published_at is null;

-- The last line of defence against publishing the same post twice. Application
-- code checks for an existing receipt first; this makes it impossible for two
-- workers racing on the same post to both write one.
create unique index if not exists published_scheduled_post_idx
  on public.published_posts(scheduled_post_id)
  where scheduled_post_id is not null;

-- Finding a post whose publish is mid-flight, without scanning the table.
create index if not exists scheduled_container_idx
  on public.scheduled_posts(platform_container_id)
  where platform_container_id is not null;

-- A worker pass claims only jobs that already existed when it began, so
-- created_at is part of the claim query rather than a display column.
create index if not exists jobs_claim_created_idx
  on public.jobs(status, created_at, run_after);
