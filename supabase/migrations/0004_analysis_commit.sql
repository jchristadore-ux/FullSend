-- The commit an analysis was derived from.
--
-- Product Intelligence is identified by the commit it describes, not by the
-- project it belongs to. The same commit always describes the same product, so
-- a refreshed page, a retried job or a second press of Analyze must never pay
-- a model to read it again; a commit that has moved on is a different product
-- to understand, and gets its own version rather than overwriting the old one.

alter table public.repositories
  add column if not exists commit_sha text;

alter table public.product_analysis
  add column if not exists commit_sha text;

-- Answering "is this commit already understood?" without a table scan.
create index if not exists product_analysis_commit_idx
  on public.product_analysis(project_id, commit_sha)
  where commit_sha is not null;
