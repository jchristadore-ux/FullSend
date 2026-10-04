-- Signed ingest (The Brovisional → FullSend): per-project auto-publish switch.
--
-- Posts pushed in through POST /api/ingest/posts land as drafts that wait for
-- approval in the Send Center. When this is on for the receiving project, they
-- are approved and scheduled straight away instead — at the requested time, or
-- the next open slot (or now) when none is given. Off by default: nothing a
-- sibling app sends goes live without a human unless someone chose that here.
--
-- Idempotency needs no new column: an ingested post's content_items.dedup_hash
-- is `ingest:<idempotency_key>`, and the existing unique index
-- content_dedup_idx (project_id, dedup_hash) already makes a duplicate
-- impossible at the database.

alter table public.projects
  add column if not exists ingest_auto_publish boolean not null default false;
