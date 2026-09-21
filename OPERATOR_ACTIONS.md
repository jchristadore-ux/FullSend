# FullSend — operator actions

Day-to-day and sale-prep actions for the person who owns production (Vercel / Supabase / Stripe / Meta). Secrets stay in the password manager and Vercel — never in git.

If another workstream also edits this file, keep section headings stable so merges stay easy.

---

## TikTok gate (enable later)

**Default:** TikTok is **off**. Instagram is the only production social destination.

| Variable | Default | Role |
| --- | --- | --- |
| `FULLSEND_TIKTOK_ENABLED` | unset / false | Master gate for connect, publish, Accounts “live”, and capabilities |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | unset | App credentials (ignored for product flows while the gate is off) |
| `TIKTOK_CLIENT_AUDITED` | false | After TikTok’s content-posting audit; until true, API posts are `SELF_ONLY` |

### Do not enable for sale honesty

Leave `FULLSEND_TIKTOK_ENABLED` unset (or `false`) on production unless you have completed audit readiness and intend to support TikTok as a live destination. Listing copy and the product UI already treat TikTok as roadmap / not available.

### If you enable TikTok later

1. Finish TikTok developer setup (Login Kit, Content Posting API, `video.publish`, URL prefix verification) — Accounts setup guide when the gate is on.
2. Set Vercel env: `FULLSEND_TIKTOK_ENABLED=true`, plus client key/secret.
3. Redeploy. Confirm Accounts shows Connect (not “Not available”) and `/api/health` capabilities reflect TikTok.
4. Keep `TIKTOK_CLIENT_AUDITED=false` until the audit passes; public posting stays blocked / `SELF_ONLY`.
5. Only then set `TIKTOK_CLIENT_AUDITED=true` and verify a public post end-to-end.
6. Do not claim TikTok in marketing until step 5 is done.

Code entry points: `src/lib/env.ts` (`env.tiktok.enabled`), `src/lib/social/registry.ts` (`livePlatforms`, `assertPlatformLive`), `LIVE_PLATFORMS` in `src/lib/types.ts` (Instagram only).

---

## Sale / ownership transfer (pointer)

Full cutover checklist: `docs/TRANSFER.md`. Acquire framing: `docs/ACQUIRE.md` (Instagram-first, young product, TikTok not production). Do not commit financials or invented traction.

---

## Related docs

- `docs/TRANSFER.md` — buyer transfer guide
- `docs/ACQUIRE.md` — Acquire.com listing pointer
- `.env.example` — env names only
- `README.md` — product workflow, Instagram scope
