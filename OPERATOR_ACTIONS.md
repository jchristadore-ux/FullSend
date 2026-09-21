# FullSend — operator actions

Day-to-day actions for the person who owns production. Secrets stay in the password manager and Vercel — never in git.

If another workstream also edits this file, keep section headings stable so merges stay easy. Other draft PRs may add **Sale / ownership transfer** or **Meta Business verification** sections — leave those headings alone when resolving conflicts.

---

## Reliability / observability

**Workstream:** reliability & observability.

### Optional upgrades (zero-config without these)

| Env | Effect when set |
| --- | --- |
| `SENTRY_DSN` | Same error captures that already land in the Control Room / authorised `/api/health` also POST to Sentry. Unset = local ring buffer only. |
| `FULLSEND_AI_TENANT_HOURLY_LIMIT` | Max AI generations per tenant per hour (default **40**). Stops one account exhausting the shared provider key. |
| `FULLSEND_ISSUE_REPO` | Dead jobs file a GitHub issue (needs `GITHUB_TOKEN`). Already documented above the video section in `.env.example`. |
| `FULLSEND_JOB_MAX_ATTEMPTS` | Retries before dead-letter (default **5**). |

### Where to look when something is wrong

1. **Control Room** `/admin` — Alerts (repeated failures, stale leases), **Dead letter** list, unresolved failures.
2. **Authorised** `GET /api/health` with `Authorization: Bearer $CRON_SECRET` — `alerts`, `queue`, `errorTracking` (never secrets).
3. Public `GET /api/health` — liveness only (`ok` + `appUrl`).

### Checklist

- [ ] Confirm heartbeat / cron is draining jobs (`queue.secondsSinceLastFinished` stays reasonable)
- [ ] If using Sentry: set `SENTRY_DSN` on Vercel and confirm one deliberate dead-letter or log.error shows up
- [ ] If multi-tenant: tune `FULLSEND_AI_TENANT_HOURLY_LIMIT` after watching Control Room AI usage
- [ ] Dead-letter backlog: fix root cause, then re-enqueue or discard from the product UI — do not delete rows by hand unless you know the idempotency keys

### Related

- `.env.example` — env names only
- `/admin` — Control Room
- `/api/health` — authorised diagnostics
