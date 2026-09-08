# FullSend — buyer transfer guide

Hand-off checklist for transferring FullSend after an asset purchase. This is an **Instagram-first** product: production content, scheduling, media, and publishing are Instagram-focused. TikTok (and other providers) may exist in the codebase but are **not** production destinations until audited and deliberately enabled.

**Do not put secret values in this file or in chat.** Rotate credentials as you transfer; treat every key as compromised until you own it.

## Stack

| Layer | Role |
| --- | --- |
| **Next.js** on **Vercel** | App, API routes, hosting |
| **Supabase** | Postgres, auth, RLS, public creative storage |
| **Stripe** | Billing (Checkout, Customer Portal, webhooks) |
| **Meta (Instagram)** | OAuth + Content Publishing API |
| **TikTok** (optional / not prod) | Login Kit + Content Posting API — see caveats |
| **Anthropic / OpenAI** | Content generation (deterministic composer if unset) |
| **GitHub** | Source of truth + Actions heartbeat cron |

## Transfer order

Do these in order so OAuth redirect URIs and webhooks keep working.

1. **GitHub** — Transfer or grant admin on `jchristadore-ux/FullSend` (or the agreed repo). Confirm branch protection, Actions secrets, and that you can push to `main`.
2. **Vercel** — Transfer the project (or recreate and point DNS). Set all env vars from the seller’s runbook / password manager — never from this doc. Confirm production domain and `NEXT_PUBLIC_APP_URL`.
3. **Supabase** — Transfer the project (or migrate DB + storage). Verify migrations in `supabase/migrations/` are applied. Confirm `fullsend-creative` (or configured) public bucket for Instagram media URLs.
4. **Stripe** — Transfer or recreate products/prices; update price IDs in Vercel env. Point the webhook to `https://YOUR_DOMAIN/api/billing/webhook`. Prefer **live** mode only after customers and keys match (see caveats).
5. **Meta / TikTok** — Transfer Meta app ownership (Business Manager) and update Instagram redirect URIs to the new domain. TikTok developer app + URL prefix verification only if you intend to enable TikTok (not required for Instagram-first operation).
6. **AI keys** — Create new Anthropic and/or OpenAI keys under the buyer’s billing; revoke seller keys after cutover.
7. **Domain** — Update DNS / Vercel domain assignment last (or in lockstep with `NEXT_PUBLIC_APP_URL` and OAuth callback URLs).

## Environment categories

Group vars the way `.env.example` does. Values live only in Vercel (and local `.env.local` for ops) — not in git.

| Category | Examples (names only) |
| --- | --- |
| **Core** | `NEXT_PUBLIC_APP_URL`, `FULLSEND_ENCRYPTION_KEY`, `FULLSEND_ADMIN_EMAILS`, `FULLSEND_CONTACT_EMAIL`, `FULLSEND_LEGAL_ENTITY` |
| **Supabase** | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `SUPABASE_STORAGE_BUCKET` |
| **AI** | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `FULLSEND_AI_MONTHLY_BUDGET_USD` |
| **GitHub** | `GITHUB_TOKEN`, optional OAuth client id/secret |
| **Instagram / Meta** | `META_APP_ID`, `META_APP_SECRET` |
| **TikTok** (optional) | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_CLIENT_AUDITED` |
| **Cron** | `CRON_SECRET` (must match Actions secret `FULLSEND_CRON_SECRET`) |
| **Billing** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_*` |
| **Video** (optional) | `FULLSEND_VIDEO_PROVIDER`, `FULLSEND_VIDEO_API_KEY` |

Also set GitHub Actions repository secrets for the heartbeat workflow: `FULLSEND_URL`, `FULLSEND_CRON_SECRET`.

## Post-transfer verification

- [ ] `/api/health` (or Control Room `/admin`) shows expected capabilities: DB, encryption, Instagram, billing as intended.
- [ ] Sign-up / sign-in via Supabase auth works on the production domain.
- [ ] Connect an Instagram business account; OAuth callback hits the new domain.
- [ ] Generate creative and confirm a public media URL Instagram can fetch (storage bucket).
- [ ] Schedule + publish a test post (or use staging) and confirm durable job recovery behavior.
- [ ] Stripe: Checkout opens; Customer Portal opens; test webhook delivery for `checkout.session.completed` / subscription events.
- [ ] Cron: GitHub Actions `heartbeat` workflow runs; `/api/cron/*` accepts `Authorization: Bearer <CRON_SECRET>`.
- [ ] Legal pages (`/terms`, `/privacy`, `/data-deletion`) show the buyer’s contact email (`FULLSEND_CONTACT_EMAIL`).
- [ ] Rotate every secret the seller ever held; confirm seller access removed from GitHub, Vercel, Supabase, Stripe, Meta, AI providers, and DNS.

## Caveats (read before cutover)

### Stripe test → live customer heal (PR #77)

After switching Stripe from **test** to **live**, stored `stripe_customer_id` values from test mode are invisible to live keys and can break Checkout with opaque 500s. The codebase heals this: on retrieve failure (`resource_missing` / deleted / no such customer), it clears the stale customer (and related ghost subscription fields when appropriate) and creates a new live customer. After go-live, one Checkout attempt per affected account should self-heal. Prefer transferring a clean live Stripe account rather than mixing modes.

### TikTok is not production

Instagram is the only active production social destination. TikTok posting stays `SELF_ONLY` until `TIKTOK_CLIENT_AUDITED=true` after TikTok’s content-posting audit. Do not market TikTok as live unless that audit and env flag are in place.

### Actions heartbeat cron

Background jobs are driven by `.github/workflows/heartbeat.yml`, not Vercel Hobby crons (Hobby refuses sub-daily schedules at deploy time). Quiet repos may see GitHub delay scheduled workflows; the workflow design compensates with longer queue sweeps. Ensure Actions secrets stay in sync with Vercel `CRON_SECRET` / app URL after transfer. On Vercel Pro you may move to native crons and disable the Actions workflow so jobs are not double-driven.

## What is not in this repo

Financials, P&L, Stripe dashboard metrics, customer lists, and the Asset Purchase Agreement live **owner-side** (data room / escrow). This repository holds product code and operational transfer guidance only.
