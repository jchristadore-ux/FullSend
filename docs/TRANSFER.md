# FullSend — buyer transfer guide

Hand-off checklist for transferring FullSend after an asset purchase. This is an **Instagram-first** product: production content, scheduling, media, and publishing are Instagram-focused. TikTok (and other providers) may exist in the codebase but are **not** production destinations until audited and deliberately enabled.

**Do not put secret values in this file or in chat.** Rotate credentials as you transfer; treat every key as compromised until you own it.

For a short operator-facing checklist, see root `OPERATOR_ACTIONS.md` → **Sale / ownership transfer**. Pair listing prep with `docs/ACQUIRE.md`. Financials stay **owner-side** (data room) — never commit ARR/MRR/user counts to git.

## Current product snapshot (verify against `main`)

| Fact | Status on current stack |
| --- | --- |
| **Product sources** | GitHub repository **or** public **website URL** (`source_type` / `website_url`; migration `0007_website_source.sql`) |
| **Social production** | **Instagram only** — Meta OAuth + Content Publishing |
| **TikTok** | Code present; **not production** until `TIKTOK_CLIENT_AUDITED=true` after TikTok audit |
| **Billing** | **Live Stripe** expected in production (Checkout, Customer Portal, webhooks). Test→live customer heal exists (see caveats) |
| **Admin / operators** | `FULLSEND_ADMIN_EMAILS` (and `users.is_admin`) → Control Room `/admin` **and** uncapped plan limits when Live billing is on |
| **Multi-app** | Send Center project switcher **+ Add app** → `/onboarding?next=/app` |
| **Schema** | Apply `supabase/migrations/` **0001 → 0007** in order (Control Room or SQL editor) |
| **Cron** | `CRON_SECRET` on Vercel; GitHub Actions `heartbeat.yml` secrets `FULLSEND_URL` + `FULLSEND_CRON_SECRET` (Hobby has no sub-daily Vercel crons) |

## Stack

| Layer | Role |
| --- | --- |
| **Next.js** on **Vercel** | App, API routes, hosting |
| **Supabase** | Postgres, auth, RLS, public creative storage |
| **Stripe** | Live billing (Checkout, Customer Portal, webhooks) |
| **Meta (Instagram)** | OAuth + Content Publishing API |
| **Product source** | GitHub **and/or** website URL (migration 0007) |
| **TikTok** (optional / not prod) | Login Kit + Content Posting API — see caveats |
| **Anthropic / OpenAI** | Content generation (deterministic composer if unset) |
| **GitHub** | Source of truth + Actions heartbeat cron |

### Migrations (must be applied through 0007)

| File | Purpose |
| --- | --- |
| `0001_fullsend_init.sql` | Core schema |
| `0002_creative_storage.sql` | Creative / storage |
| `0003_durable_publishing.sql` | Durable publish jobs |
| `0004_analysis_commit.sql` | Analysis commit tracking |
| `0005_project_brand_identity.sql` | Brand identity |
| `0006_generation_state.sql` | Generation state |
| `0007_website_source.sql` | Website URL as product source (`website_sources`, `projects.source_type`) |

Missing `0007` → website onboarding cannot persist; Control Room migration card / health will flag it.

## Ownership-transfer checklist

Complete these so OAuth redirect URIs, webhooks, and cron keep working. Prefer this order.

### 1. GitHub

- [ ] Transfer or grant admin on `jchristadore-ux/FullSend` (or the agreed repo)
- [ ] Confirm you can push to `main`; review branch protection
- [ ] Rotate / set Actions secrets: `FULLSEND_URL`, `FULLSEND_CRON_SECRET` (must match Vercel `CRON_SECRET`)
- [ ] Confirm `GITHUB_TOKEN` (and optional GitHub OAuth client) under the buyer’s account if repo-connect is used

### 2. Vercel

- [ ] Transfer the project (or recreate and point DNS)
- [ ] Set **all** env vars from the seller’s private runbook / password manager — **never** from this doc
- [ ] Confirm production domain and `NEXT_PUBLIC_APP_URL`
- [ ] Redeploy production after env changes

### 3. Supabase

- [ ] Transfer the project (or migrate DB + storage)
- [ ] Verify migrations **0001–0007** are applied
- [ ] Confirm public creative bucket (e.g. `fullsend-creative` / `SUPABASE_STORAGE_BUCKET`) for Instagram media URLs
- [ ] Rotate URL / anon / service role / DB URL; update Auth redirect URLs for the new domain

### 4. Stripe (Live)

- [ ] Transfer the Live Stripe account **or** recreate Live products/prices/portal/webhook under the buyer
- [ ] Update `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_*` in Vercel (**all live**, not test)
- [ ] Point webhook to `https://YOUR_DOMAIN/api/billing/webhook`
- [ ] Smoke: Checkout opens with a **live** session; Customer Portal opens; webhook deliveries succeed

### 5. Meta app (Instagram)

- [ ] Transfer Meta app ownership (Business Manager) **or** recreate and re-review
- [ ] Update Instagram OAuth redirect URI: `{NEXT_PUBLIC_APP_URL}/api/accounts/instagram/callback`
- [ ] Set `META_APP_ID` / `META_APP_SECRET` (and related Meta env) on Vercel
- [ ] TikTok developer app + URL verification **only if** you intend to enable TikTok (not required for Instagram-first)

### 6. Domain

- [ ] Update DNS / Vercel domain assignment in lockstep with `NEXT_PUBLIC_APP_URL` and OAuth / Auth callbacks
- [ ] If staying on `*.vercel.app`, document that clearly for buyers (no invented custom-domain claims)

### 7. AI keys

- [ ] Create Anthropic and/or OpenAI keys under the buyer’s billing; set optional `FULLSEND_AI_MONTHLY_BUDGET_USD`
- [ ] Revoke seller keys after cutover

### 8. Cron (`CRON_SECRET` / external cron)

- [ ] Set `CRON_SECRET` on Vercel
- [ ] Mirror as Actions `FULLSEND_CRON_SECRET` + set `FULLSEND_URL` to the production app URL
- [ ] Confirm `.github/workflows/heartbeat.yml` runs; `/api/cron/*` accepts `Authorization: Bearer <CRON_SECRET>`
- [ ] On Vercel Pro you may move to native crons and **disable** the Actions workflow so jobs are not double-driven
- [ ] Alternate external cron is fine if it hits the same endpoints with the same bearer secret

### 9. `FULLSEND_ADMIN_EMAILS`

- [ ] Set buyer operator emails (comma-separated) on Vercel — grants `/admin` Control Room **and** unlimited plan limits when Live Stripe billing is on
- [ ] Remove seller emails after cutover; sign in again so session picks up the new list
- [ ] Optional: `users.is_admin` in DB for the same unlimited behavior

## Environment categories

Group vars the way `.env.example` does. Values live only in Vercel (and local `.env.local` for ops) — not in git.

| Category | Examples (names only) |
| --- | --- |
| **Core** | `NEXT_PUBLIC_APP_URL`, `FULLSEND_ENCRYPTION_KEY`, `FULLSEND_ADMIN_EMAILS`, `FULLSEND_CONTACT_EMAIL`, `FULLSEND_LEGAL_ENTITY` |
| **Supabase** | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `SUPABASE_STORAGE_BUCKET` |
| **AI** | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `FULLSEND_AI_MONTHLY_BUDGET_USD` |
| **GitHub** | `GITHUB_TOKEN`, optional OAuth client id/secret |
| **Instagram / Meta** | `META_APP_ID`, `META_APP_SECRET` |
| **TikTok** (optional / off by default) | `FULLSEND_TIKTOK_ENABLED`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_CLIENT_AUDITED` |
| **Cron** | `CRON_SECRET` (must match Actions secret `FULLSEND_CRON_SECRET`) |
| **Billing (Live)** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_*` |
| **Video** (optional) | `FULLSEND_VIDEO_PROVIDER`, `FULLSEND_VIDEO_API_KEY` |

Also set GitHub Actions repository secrets for the heartbeat workflow: `FULLSEND_URL`, `FULLSEND_CRON_SECRET`.

## Post-transfer verification

- [ ] `/api/health` (or Control Room `/admin`) shows expected capabilities: DB, encryption, Instagram, billing as intended; migrations through 0007
- [ ] Sign-up / sign-in via Supabase auth works on the production domain
- [ ] Onboard via **GitHub** and/or **website URL**; **Add app** from Send Center opens onboarding and returns to `/app`
- [ ] Connect an Instagram business account; OAuth callback hits the new domain
- [ ] Generate creative and confirm a public media URL Instagram can fetch (storage bucket)
- [ ] Schedule + publish a test post (or use staging) and confirm durable job recovery behavior
- [ ] Stripe **Live**: Checkout opens; Customer Portal opens; webhook delivery for `checkout.session.completed` / subscription events
- [ ] Operator email in `FULLSEND_ADMIN_EMAILS` sees unlimited limits in `/app/billing` and can open `/admin`
- [ ] Cron: GitHub Actions `heartbeat` (or external cron) runs; `/api/cron/*` accepts bearer `CRON_SECRET`
- [ ] Legal pages (`/terms`, `/privacy`, `/data-deletion`) show the buyer’s contact email (`FULLSEND_CONTACT_EMAIL`)
- [ ] Rotate every secret the seller ever held; confirm seller access removed from GitHub, Vercel, Supabase, Stripe, Meta, AI providers, DNS, and admin email list

## Caveats (read before cutover)

### Stripe test → live customer heal (PR #77)

After switching Stripe from **test** to **live**, stored `stripe_customer_id` values from test mode are invisible to live keys and can break Checkout with opaque 500s. The codebase heals this: on retrieve failure (`resource_missing` / deleted / no such customer), it clears the stale customer (and related ghost subscription fields when appropriate) and creates a new live customer. After go-live, one Checkout attempt per affected account should self-heal. Prefer transferring a **clean Live** Stripe account rather than mixing modes.

### TikTok is not production

Instagram is the only active production social destination. TikTok is **off by default** (`FULLSEND_TIKTOK_ENABLED` unset/false): connect and publish refuse, and the Accounts UI shows “Not available.” Even with credentials, do not market TikTok as live.

If you deliberately enable it later: set `FULLSEND_TIKTOK_ENABLED=true`, complete Login Kit + Content Posting API setup, then `TIKTOK_CLIENT_AUDITED=true` only after TikTok’s content-posting audit (until then posts stay `SELF_ONLY`). See `OPERATOR_ACTIONS.md`.

### Actions heartbeat cron

Background jobs are driven by `.github/workflows/heartbeat.yml`, not Vercel Hobby crons (Hobby refuses sub-daily schedules at deploy time). Quiet repos may see GitHub delay scheduled workflows; the workflow design compensates with longer queue sweeps. Ensure Actions secrets stay in sync with Vercel `CRON_SECRET` / app URL after transfer. On Vercel Pro you may move to native crons and disable the Actions workflow so jobs are not double-driven.

### Website source needs migration 0007

Projects can be grounded in a public website instead of a GitHub repo. Without `0007_website_source.sql`, website onboarding cannot record `source_type` / `website_url` / `website_sources`. Apply via Control Room or SQL editor before marketing website-source as available.

## What is not in this repo

Financials, P&L, Stripe dashboard metrics, customer lists, and the Asset Purchase Agreement live **owner-side** (data room / escrow). This repository holds product code and operational transfer guidance only. **Do not invent ARR, MRR, or user counts** in docs or listing copy.
