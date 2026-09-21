# Operator actions

Day-to-day and sale-prep actions for whoever owns production (Vercel / Supabase / Stripe / Meta). Secrets stay in the password manager and Vercel — never in git.

If another workstream also edits this file, keep section headings stable so merges stay easy.

---

## Growth / acquisition

**Workstream:** growth (landing, no-signup demo, first-run, Acquire metrics).

### Landing + demo

- [ ] Confirm production marketing URL serves `/` with the honesty band (Instagram-first, no invented ARR).
- [ ] Smoke the public demo: `POST /api/demo` with a public GitHub URL (e.g. `vercel/next.js`) — expect analysis + sample post + publish wall.
- [ ] Confirm rate limits: more than 3 demo runs / hour / IP returns 429; private repos and `http://127.0.0.1` are refused.
- [ ] Website demo path only accepts public https URLs (SSRF guard).

### First-run

- [ ] New account with no project lands on `/onboarding`.
- [ ] After analysis, Send Center shows the four-step first-run checklist (analyse → connect Instagram → approve plan → first post).
- [ ] Checklist clears step-by-step as Instagram connects, strategy is approved, and a post publishes.

### Acquire data room (Control Room)

- [ ] Sign in as an admin (`FULLSEND_ADMIN_EMAILS`) and open `/admin`.
- [ ] Confirm the **Acquire data room** panel shows signups, activation, first publish, publish volume, job success, MRR, paying customers.
- [ ] Treat zeros as real. Do not paste estimated ARR/MRR into Acquire.com — export Stripe + this panel only.
- [ ] Financial P&L stays owner-side / out of git (`docs/ACQUIRE.md`).

### Out of scope for this workstream

Meta app review, cron/scheduler punctuality, TikTok production publishing, ownership transfer checklists — other draft PRs own those.

---

## Related docs

- `docs/ACQUIRE.md` — listing honesty checklist
- `docs/TRANSFER.md` — buyer handoff
- `.env.example` — env names only
