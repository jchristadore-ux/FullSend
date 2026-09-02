-- The visual half of a brand profile.
--
-- A brand profile until now held voice: how a project sounds. It held three
-- colours, and every project got the same three, because `strategy/build.ts`
-- wrote FullSend's own orange into every row it created. So every project
-- FullSend markets looked like FullSend — which is exactly backwards. FullSend
-- is the engine; the application is the brand.
--
-- These columns hold what a repository can actually be read to say about how
-- its product looks, plus the provenance of each answer. Nothing here is
-- required and nothing defaults to a FullSend value: a field the repository
-- does not answer stays empty, and empty means unknown rather than "assume
-- ours". A renderer that finds no brand colour uses a neutral, which is
-- honest; one that finds FullSend's is claiming something false about
-- somebody else's product.

alter table public.brand_profiles
  -- The name the product calls itself, which is not always the project name.
  add column if not exists brand_name text not null default '',

  -- Beyond the original three. Accent and text are what a real palette needs
  -- to typeset a card without inventing anything.
  add column if not exists accent_color text not null default '',
  add column if not exists text_color text not null default '',

  -- Typography. Stored as a full CSS font stack so a renderer never has to
  -- guess a fallback, and an unavailable webfont degrades to a real family
  -- rather than to whatever the renderer happens to default to.
  add column if not exists heading_font text not null default '',
  add column if not exists body_font text not null default '',

  -- The product's own mark, when the repository carries one that can be used.
  -- A URL to the file in the repository, not a copy: assets are not duplicated.
  add column if not exists logo_url text,
  add column if not exists logo_dark_url text,

  -- Descriptive identity. Free text, because these are read from a repository
  -- and summarised rather than chosen from a fixed list.
  add column if not exists icon_style text not null default '',
  add column if not exists design_language text not null default '',
  add column if not exists imagery_style text not null default '',
  add column if not exists graphic_style text not null default '',
  add column if not exists brand_personality text not null default '',

  -- Rules content generation and QC are held to.
  add column if not exists brand_keywords jsonb not null default '[]'::jsonb,
  add column if not exists visual_dos jsonb not null default '[]'::jsonb,
  add column if not exists visual_donts jsonb not null default '[]'::jsonb,
  add column if not exists content_dos jsonb not null default '[]'::jsonb,
  add column if not exists content_donts jsonb not null default '[]'::jsonb,

  -- Where each answer came from: {"primary_color": "src/app/globals.css", ...}.
  -- A founder correcting a wrong colour deserves to know what was read to
  -- produce it, and a field absent from here was never discovered at all.
  add column if not exists identity_sources jsonb not null default '{}'::jsonb,

  -- Fields a human has edited. Re-analysis fills gaps and refreshes what it
  -- discovered, but never overwrites one of these — an override that a later
  -- analysis silently reverts is not an override, and brand drift is exactly
  -- what this profile exists to prevent.
  add column if not exists locked_fields jsonb not null default '[]'::jsonb,

  add column if not exists identity_discovered_at timestamptz;

-- The original three defaulted to FullSend's palette at the column level, so
-- even a row inserted without touching them came out orange. New rows now
-- start empty and mean it.
alter table public.brand_profiles alter column primary_color set default '';
alter table public.brand_profiles alter column secondary_color set default '';
alter table public.brand_profiles alter column background_color set default '';

-- Clearing the palette the bug wrote.
--
-- Changing the default does nothing for rows that already exist, and every
-- brand profile written before today carries FullSend's orange — not because
-- anybody chose it, but because `buildBrandProfile` hardcoded it at insert. Left
-- alone, every existing project would keep publishing in FullSend's colours,
-- which is the whole defect.
--
-- The predicate is deliberately narrow, because this is a destructive statement
-- running on live data and the cost of over-reaching is erasing a founder's
-- real decision:
--
--   * all three colours match the hardcoded triple exactly. Any project that
--     genuinely chose one of them has almost certainly not chosen all three in
--     that combination.
--   * the project is not FullSend's own. On `is_internal` these values are
--     correct — there the engine and the brand really are the same product.
--   * nothing has been locked by hand. A founder who has already corrected part
--     of this profile is expressing an intent, and this must not touch it.
--
-- Emptied rather than replaced: empty means unknown, the renderer draws a
-- neutral, and the next analysis fills it in from the project's own repository.
-- Guessing a replacement here would repeat the original mistake with different
-- numbers.
update public.brand_profiles b
   set primary_color = '',
       secondary_color = '',
       background_color = ''
  from public.projects p
 where p.id = b.project_id
   and p.is_internal = false
   and b.primary_color = '#FF5A1F'
   and b.secondary_color = '#FFFFFF'
   and b.background_color = '#08090A'
   and coalesce(jsonb_array_length(b.locked_fields), 0) = 0;

-- ── Pinning a post to its destination ─────────────────────────────────────
--
-- `scheduled_posts.social_account_id` already exists but was advisory: the
-- publisher resolved the account fresh from (project, platform) at publish
-- time and ignored the column. That is a destination that can change under a
-- scheduled post — reconnect a project to a different Instagram account and
-- everything already queued silently retargets.
--
-- `on delete set null` stays: a deleted account must not take the post's
-- history with it. The publisher now treats a null here as "resolve and pin",
-- and a set value as binding.
create index if not exists scheduled_account_idx
  on public.scheduled_posts(social_account_id)
  where social_account_id is not null;
