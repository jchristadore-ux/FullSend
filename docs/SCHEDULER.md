# Punctual scheduler

GitHub Actions’ heartbeat asks for every five minutes. On a quiet repository
GitHub throttles that schedule hard — measured gaps of **45 minutes to several
hours** are normal. Publishing is not lost (the next run sweeps everything
already due), but it is late.

For real punctuality, drive `/api/cron/queue` from an **external pinger** every
five minutes. Keep the Actions workflow as a fallback, or disable one of the
two so jobs are not double-driven.

## Canonical origin (308 trap)

Vercel answers **308** for any origin that is not the deployment’s canonical
host (`http` vs `https`, www/apex mismatch, alias vs production domain). Most
HTTP clients treat a 308 as success and do not follow it with credentials, so a
mis-set URL returns a body like `Redirecting...` and the queue **never runs**
while the scheduler looks healthy.

**Before configuring any pinger:**

1. Open `GET https://<whatever-you-think>/api/health` (no auth).
2. Read `appUrl` from the JSON. That string is the only origin to use.
3. Point the pinger at `{appUrl}/api/cron/queue` with **no trailing slash** on
   the origin, `https`, and the host exactly as reported.
4. Treat **any status other than HTTP 200** as failure — including 3xx. Do not
   follow redirects with the bearer secret attached.

## Endpoint

```http
POST {appUrl}/api/cron/queue
Authorization: Bearer <CRON_SECRET>
```

`CRON_SECRET` is the Vercel env var of the same name. GET is also accepted (same
header) for schedulers that only support GET.

Each call is one **bounded worker pass** (one expensive job max, time budget,
no chain-following). Idempotent publishing is unchanged. You do not need to
also hit `/api/cron/publish` every five minutes — the queue pass drains due
publish jobs; the Actions workflow still runs publish on its own cadence when
used as fallback.

## Setup: cron-job.org

1. Create an account at [cron-job.org](https://cron-job.org).
2. **Create cronjob** → URL: `{appUrl}/api/cron/queue` (from `/api/health`).
3. Schedule: every **5 minutes**.
4. Request method: **POST** (or GET if you prefer).
5. Headers: `Authorization` = `Bearer <CRON_SECRET>` (same value as Vercel
   `CRON_SECRET`).
6. Enable “Fail if HTTP status is not 2xx” / equivalent — **required**.
7. Save. Trigger once manually and confirm HTTP 200 and a JSON body with
   `ok: true` (and `processed` / `stopped` fields).

## Setup: Cronitor

1. Create a monitor of type **Heartbeat** or **Job** that can issue an HTTP
   request (Cronitor “Telemetry” / synthetic check that POSTs).
2. URL: `{appUrl}/api/cron/queue`.
3. Method: POST. Header: `Authorization: Bearer <CRON_SECRET>`.
4. Interval: 5 minutes. Alert on non-200 (including redirects).
5. Optional: also watch `/api/health` (authorized with the same bearer) and
   alert when `queue.workerStale` is true — see Self-check below.

## Setup: UptimeRobot

1. Add a **Keyword** or **HTTP(s)** monitor is not enough by itself — you need
   an authenticated request. Use **UptimeRobot’s custom HTTP monitor** (or a
   paid “API”/multi-step check) that can set method + headers.
2. URL: `{appUrl}/api/cron/queue`.
3. Method: POST. Header: `Authorization: Bearer <CRON_SECRET>`.
4. Interval: 5 minutes. Consider keyword monitoring for `"ok":true` in the body.
5. Alert on any status ≠ 200.

If your UptimeRobot plan cannot set an Authorization header, use cron-job.org
or Cronitor for the queue driver and keep UptimeRobot on public `/api/health`
liveness only.

## One driver, or two on purpose

| Driver | Role |
| --- | --- |
| External pinger (every 5m) | **Primary** for punctual publish |
| GitHub Actions `heartbeat.yml` | **Fallback** / long sweep on public repos |
| Vercel Pro `vercel.json` crons | Alternative primary — not available on Hobby |

**Disable one** when you turn another into the primary:

- **Disable Actions:** Repo → Actions → FullSend heartbeat → `…` → Disable
  workflow. Or cancel/pause the schedule and leave `workflow_dispatch` if you
  still want manual runs.
- **Disable external pinger:** Pause/delete the cron-job.org / Cronitor /
  UptimeRobot job.
- **Disable Vercel crons:** Remove the `crons` block from `vercel.json` (Hobby
  cannot use sub-daily crons anyway).

Two actives are safe for **correctness** (claiming is atomic; publishing is
idempotent) but waste quota and muddy logs. Prefer one primary + documented
fallback.

Actions secrets (when using the workflow): `FULLSEND_URL` = `appUrl` from
health, `FULLSEND_CRON_SECRET` = Vercel `CRON_SECRET`. The workflow already
resolves redirects on `/api/health` and fails closed on non-200 cron responses.

## Self-check

Authorized `GET /api/health` (Bearer `CRON_SECRET`) includes:

- `queue.lastWorkerPassAt` — last time a worker pass completed successfully
  (including empty passes).
- `queue.secondsSinceLastWorkerPass`
- `queue.workerStale` — true when no successful pass completed within
  `FULLSEND_WORKER_STALE_MINUTES` (default **15**).

The Control Room (`/admin`) surfaces the same warning. These are measured
timestamps, not estimates.

## Customer-visible drift

Published posts show **scheduled for** vs **actually published**, and how late
the send was, on the content detail and calendar views. That drift is often the
first customer-visible symptom of a throttled or mis-aimed scheduler.
