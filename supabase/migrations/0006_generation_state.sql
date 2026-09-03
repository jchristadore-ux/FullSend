-- Is this post actually finished being made?
--
-- `content_items.status` answers a different question — what should happen to
-- this post next — and it was being asked to answer both. A post whose copy
-- was written and whose creative silently failed carried an ordinary status,
-- so it scheduled itself, drew an empty box above its caption, and counted as
-- a success everywhere it was counted.
--
-- The two states are genuinely different: a finished post can be held for
-- review, and an approved post can have no creative at all. So generation gets
-- its own column, with a real failed state and the reason attached.
--
-- The default is `complete`, deliberately. Every row written before this column
-- existed either has creative or does not; marking the whole back catalogue as
-- unfinished would be a claim the database cannot support, and would stop
-- posts that are already scheduled and fine.

alter table public.content_items
  add column if not exists generation_state text not null default 'complete',
  add column if not exists generation_error text;

alter table public.content_items
  drop constraint if exists content_items_generation_state_check;
alter table public.content_items
  add constraint content_items_generation_state_check
  check (generation_state in (
    'pending','generating_copy','copy_complete','generating_creative',
    'creative_complete','complete','failed'
  ));

-- The founder's view of "what is stuck" reads this, and it is a small slice of
-- a large table.
create index if not exists content_generation_failed_idx
  on public.content_items(project_id)
  where generation_state = 'failed';

-- ── A second platform token, kept out of the metadata blob ────────────────
--
-- Under Facebook Login, publishing uses a *Page* access token rather than the
-- user token. It was being stored in `social_accounts.platform_metadata`,
-- which is a plain jsonb column the accounts API returns to the browser. A
-- credential that reaches a client is a leaked credential, whatever the intent.
--
-- It belongs in the vault beside the token it accompanies: encrypted, never
-- selectable by a client, and scoped to one social account — so one brand's
-- Page token can never be read while publishing for another.
alter table public.oauth_tokens
  add column if not exists platform_token_encrypted text;
