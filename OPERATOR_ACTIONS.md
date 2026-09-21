# FullSend — operator actions

Day-to-day and sale-prep actions for the person who owns production (Vercel / Supabase / Stripe / Meta). Secrets stay in the password manager and Vercel — never in git.

If another workstream also edits this file, keep section headings stable. The sale block below is named explicitly so merges stay easy.

---

## Sale / ownership transfer

**Workstream:** sale readiness. **Do not merge financials into git.**

Use this as the short checklist; details and caveats live in `docs/TRANSFER.md`. Listing framing: `docs/ACQUIRE.md` (Instagram-first, young product, TikTok not production).

### Before listing (owner)

- [ ] Confirm production uses **Live** Stripe keys/prices (not test) and webhook → `/api/billing/webhook`
- [ ] Confirm Supabase has migrations **0001–0007** applied (website source = `0007`)
- [ ] Confirm Instagram connect + publish path works; do **not** claim TikTok as live
- [ ] Set `FULLSEND_ADMIN_EMAILS` to current operator(s); remove stale addresses
- [ ] Confirm `CRON_SECRET` matches Actions `FULLSEND_CRON_SECRET` (or your external cron bearer)
- [ ] Prepare **owner-side** data room (P&L, Stripe exports, demos) — never commit numbers
- [ ] Read `docs/ACQUIRE.md` honesty checklist before pasting Acquire copy

### Transfer cutover (buyer + seller)

| # | System | Action |
| --- | --- | --- |
| 1 | **GitHub** | Transfer repo admin; rotate Actions secrets `FULLSEND_URL`, `FULLSEND_CRON_SECRET` |
| 2 | **Vercel** | Transfer project; copy env from private runbook; set `NEXT_PUBLIC_APP_URL`; redeploy |
| 3 | **Supabase** | Transfer project; verify migrations through **0007**; rotate keys; Auth URLs |
| 4 | **Stripe** | Transfer **Live** account or recreate Live catalog + webhook; update price IDs |
| 5 | **Meta app** | Transfer Business ownership; update Instagram redirect URI to new domain |
| 6 | **Domain** | DNS / Vercel domain in lockstep with app URL + OAuth callbacks |
| 7 | **AI keys** | New Anthropic/OpenAI under buyer; revoke seller keys |
| 8 | **Cron** | `CRON_SECRET` on Vercel ↔ Actions or external cron; smoke `/api/cron/*` |
| 9 | **`FULLSEND_ADMIN_EMAILS`** | Buyer emails only; seller removed; re-login to pick up unlimited + `/admin` |

### After cutover (buyer)

- [ ] `/api/health` + Control Room look healthy
- [ ] Add app (Send Center) → onboarding (GitHub **or** website) → return to `/app`
- [ ] Instagram OAuth + one durable publish test
- [ ] Live Checkout + Customer Portal + webhook delivery
- [ ] Heartbeat / cron actually draining jobs
- [ ] Seller access removed everywhere (GitHub, Vercel, Supabase, Stripe, Meta, AI, DNS, admin list)

### Out of scope for git

Financials, ARR/MRR, user counts, customer lists, APA — **owner-side data room only**. Do not invent metrics in this file or in `docs/`.

---

## Related docs

- `docs/TRANSFER.md` — full buyer transfer guide
- `docs/ACQUIRE.md` — Acquire.com listing pointer
- `.env.example` — env names only
- `README.md` — product workflow, Instagram scope, billing
