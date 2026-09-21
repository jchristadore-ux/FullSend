# Operator actions — Meta Business verification

Only the Meta app / Business portfolio **owner** can complete these. Engineering cannot finish App Review without them.

Production app URL: **https://full-send-lyart.vercel.app**

---

## 1. Confirm App Dashboard URLs

In [Meta for Developers](https://developers.facebook.com/apps/) → your FullSend app:

### App settings → Basic

| Field | Value to paste |
| --- | --- |
| Privacy Policy URL | `https://full-send-lyart.vercel.app/privacy` |
| Terms of Service URL | `https://full-send-lyart.vercel.app/terms` |
| User data deletion / Data deletion instructions URL | `https://full-send-lyart.vercel.app/data-deletion` |
| Data Deletion Request Callback URL | `https://full-send-lyart.vercel.app/api/accounts/instagram/data-deletion` |
| Deauthorize Callback URL | `https://full-send-lyart.vercel.app/api/accounts/instagram/deauthorize` |
| App icon / category / contact email | Complete if Meta marks incomplete |

### Instagram product → API setup with Instagram login → Business login settings

| Field | Value |
| --- | --- |
| OAuth redirect URIs | `https://full-send-lyart.vercel.app/api/accounts/instagram/callback` |

Paste **exactly** (https, path, no trailing slash mismatch). Wrong box (Facebook Login vs Instagram Login) causes redirect_uri errors that look like app bugs.

### Optional check

After deploy of this branch: open `https://full-send-lyart.vercel.app/api/health/meta` and confirm `redirectUri` / `callbacks` match what you pasted. The JSON never includes secrets.

---

## 2. Permissions to request (Advanced Access)

Request **only** (Instagram Login — production default):

1. `instagram_business_basic`
2. `instagram_business_content_publish`
3. `instagram_business_manage_insights`

Do **not** request retired names (`instagram_basic`, `instagram_content_publish`) unless Meta’s current docs still list them for your login mode.

Attach:

- Screencast recorded from `docs/meta-app-review/screencast-script.md`
- Justifications from `docs/meta-app-review/permission-justifications.md`
- Reviewer steps from `docs/meta-app-review/reviewer-instructions.md`

---

## 3. Business Verification (gates Advanced Access for other people’s accounts)

If every Instagram account you connect is **yours**, you can stay in Development Mode and add **Instagram testers** — Business Verification is optional for that path.

If **other people** will connect their own Instagram accounts to FullSend, Meta typically requires:

1. Meta Business Suite / Business Settings → **Security Center** → **Start Verification**.
2. Legal business name, address, phone, and business type matching official documents.
3. Upload documentation Meta accepts (e.g. articles of incorporation, tax registration, utility bill — follow the on-screen list for your country).
4. Complete any domain / email ownership challenges Meta sends.
5. Wait for **Verified** status before (or as required during) App Review for Advanced Access.
6. After permissions are approved, switch **App Mode** from Development → **Live**.

Engineering cannot upload your tax ID or accept Business Manager invites on your behalf.

---

## 4. Test users for the review

1. App roles → Roles → add Meta reviewers / your demo user as needed.
2. Add the demo Instagram account as **Instagram tester** and accept the invite in Instagram settings (Website permissions → Tester invites).
3. Put the FullSend magic-link inbox + Instagram credentials into the App Review instructions (private to Meta).

---

## 5. After approval

1. Confirm Advanced Access shows **Approved** for the three scopes.
2. Toggle App Mode → **Live** (only when you intend third-party connects).
3. Smoke-test Connect on an account that is **not** a tester.
4. Re-check `/api/health/meta` and legal URLs still 200.
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

- `docs/meta-app-review/` — full submission package
- `src/lib/social/setup-guides.ts` — in-app setup copy
- `src/lib/social/meta-app.ts` — Development Mode vs Live failure messaging
