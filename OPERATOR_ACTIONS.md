# FullSend — operator actions

Day-to-day actions for the person who owns production (Vercel / Supabase /
Stripe / Meta / cron). Secrets stay in the password manager and Vercel — never
in git.

If another workstream also edits this file, keep section headings stable so
merges stay easy.

---

## Punctual scheduler

**Workstream:** scheduler punctuality. Full detail: `docs/SCHEDULER.md`.

### Why this exists

GitHub Actions’ heartbeat is throttled (often 45m–4h on quiet repos). A silent
**308** redirect makes cron look healthy while the queue never runs. For
punctual publishes, drive the queue from an external pinger.

### Checklist — external pinger (primary)

- [ ] `GET {candidate}/api/health` → copy `appUrl` exactly (canonical origin)
- [ ] Create cron-job.org / Cronitor / UptimeRobot job:
  - URL: `POST {appUrl}/api/cron/queue`
  - Header: `Authorization: Bearer <CRON_SECRET>` (matches Vercel)
  - Every **5 minutes**
  - **Fail on any status ≠ 200** (including 3xx)
- [ ] Manual run returns 200 + JSON `ok: true`
- [ ] Decide fallback: keep Actions, or disable it (see below)

### Checklist — avoid double-driving

| Keep as primary | Disable the other |
| --- | --- |
| External pinger | Actions → FullSend heartbeat → Disable workflow |
| Actions heartbeat | Pause/delete the external cron job |
| Vercel Pro crons | Disable Actions **and** any external pinger |

Correctness holds with two drivers (atomic claim + idempotent publish) but you
pay twice and logs get noisy. Prefer one primary.

### Checklist — Actions fallback (optional)

- [ ] Repo secrets: `FULLSEND_URL` = health `appUrl`, `FULLSEND_CRON_SECRET` = `CRON_SECRET`
- [ ] Workflow preflight is green (secret accepted, no 308 on cron)
- [ ] On a **private** repo, continuous sweep burns Actions minutes — prefer the
      pinger or shorten the sweep deadline in `heartbeat.yml`

### Checklist — self-check

- [ ] Authorized `/api/health` shows `queue.lastWorkerPassAt` updating
- [ ] `queue.workerStale` is false under the pinger (default threshold 15 minutes;
      override with `FULLSEND_WORKER_STALE_MINUTES`)
- [ ] Control Room (`/admin`) shows no “worker has not completed a pass” warning

### 308 trap (do not skip)

Schedulers must use the origin from `/api/health` → `appUrl`. Treat non-200 as
failure. Never follow redirects with the bearer secret attached. Details in
`docs/SCHEDULER.md` and comments in `.github/workflows/heartbeat.yml`.

---

## Related docs

- `docs/SCHEDULER.md` — pinger setup (cron-job.org / Cronitor / UptimeRobot)
- `docs/TRANSFER.md` — ownership transfer (when present)
- `docs/ACQUIRE.md` — Acquire.com listing pointer (when present)
- `.env.example` — env names only
- `README.md` — product workflow + short scheduler summary
- `.github/workflows/heartbeat.yml` — Actions fallback / long sweep
