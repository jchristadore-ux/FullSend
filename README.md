# FullSend

**Everything goes live.**

FullSend is an autonomous marketing/content engine for applications. Connect a GitHub repository and FullSend builds verified product intelligence, a marketing plan, Instagram content, creative, scheduling, publishing, and analytics.

## Production workflow

```text
GitHub repository
      ↓
Product Intelligence (durable)
      ↓
Marketing Plan (durable)
      ↓
Instagram Content (durable jobs)
      ↓
Creative / Media (durable public URLs)
      ↓
Review / Approval
      ↓
Schedule
      ↓
Background Worker
      ↓
Instagram Publishing
      ↓
Analytics
      ↓
Optimization
```

Major operations are persisted as jobs. Closing the browser does not stop work. Refreshing the application does not restart completed stages. Retries resume the failed operation rather than restarting the whole pipeline.

### The worker contract

An HTTP request creates durable jobs and returns. A worker pass runs separately and is bounded three ways, each closing a different route back to a request that outlives its own invocation:

- **One expensive job per pass.** Anything that calls an AI provider or publishes to Instagram ends the pass. Thirty posts are thirty passes, never one long one.
- **A job count and a wall-clock budget.** Light bookkeeping jobs drain quickly; the pass still ends well inside the invocation it was given, and a pass with no budget left claims nothing rather than starting work it cannot finish.
- **No chain-following.** A pass claims only jobs that existed when it began. A completed job enqueues its successor, and that successor belongs to the next pass — so *analyse → plan → content* never runs as one chain of AI calls.

Publishing is durable in the same sense. Instagram publishes in two calls — create a media container, then publish it — and the container id is written down before the publish call, the submission timestamp immediately before it goes out. If the response is lost, the next attempt asks Instagram what actually happened rather than publishing again. A unique index on the receipt is the backstop.

## Instagram scope

Instagram is the only active production social destination. The codebase may retain provider abstractions for future expansion, but the production content, scheduling, media, and publishing flow is Instagram-focused.

## Local development

Requires Node.js 22.x.

```bash
npm ci
npm run dev
```

Useful commands:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run e2e
npm run worker
```

Linting is the ESLint CLI against `eslint.config.mjs`. Next 16 removed `next lint`, and `next build` no longer lints.

## Deployment

FullSend uses Next.js/Vercel for the application and Supabase for persistence, authentication, and media storage.

Run the database migrations in `supabase/migrations/` in order:

| Migration | What it adds |
| --- | --- |
| `0001_fullsend_init.sql` | Every table, and the RLS policies that keep tenants apart. |
| `0002_creative_storage.sql` | The public `fullsend-creative` bucket Instagram fetches media from. |
| `0003_durable_publishing.sql` | The columns that make a publish recoverable, and the unique index that makes publishing the same post twice impossible. |
| `0004_analysis_commit.sql` | The commit an analysis was derived from, so the same commit is never analysed twice. |

A migration file in the repository is not a migration in the database. `GET /api/health` checks each one against the live schema — including whether the storage bucket exists and is public — and names the file to run for anything missing.

Required production configuration includes:

```text
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
FULLSEND_ENCRYPTION_KEY
CRON_SECRET
ANTHROPIC_API_KEY or OPENAI_API_KEY
```

GitHub Actions drives the background queue/heartbeat. The worker claims jobs with a lease, persists results, retries bounded failures, and recovers stale work.

### How often the queue actually drains

`.github/workflows/heartbeat.yml` asks for `*/5 * * * *`. GitHub does not honour it. Scheduled workflows are throttled hard on quiet repositories, and in practice this one fires anywhere from 45 minutes to four hours apart.

Nothing in the schedule can fix that, so the run compensates for it: the queue job stays up and sweeps continuously — polling every 15 seconds while there is work and every 60 seconds when idle — until the next firing cancels and replaces it. Coverage comes from runs being long rather than from the schedule being punctual.

**On a public repository this is free**: Actions minutes are unmetered. **On a private repository it is not** — a continuous sweep will consume your monthly Actions allowance. There, either shorten the `deadline` in the workflow or use an external pinger instead.

### Driving the queue from outside GitHub

For a genuinely punctual worker, point any scheduler at the queue endpoint:

```
POST https://<your-app>/api/cron/queue
Authorization: Bearer <CRON_SECRET>
```

Every five minutes is a sensible interval; each call is a bounded worker pass and returns as soon as it has done its allowance. Free services that do this include cron-job.org, Cronitor and UptimeRobot. On Vercel Pro you can use native crons in `vercel.json` instead — disable the Actions workflow if you do, so the jobs are not driven twice.

**Whatever drives it, treat anything other than HTTP 200 as a failure — a redirect especially.** Vercel answers `308` for any origin that is not the canonical one: `http://` rather than `https`, a www/apex mismatch, a deployment alias pointing at the production domain. Most HTTP clients neither follow a redirect by default nor call it an error, so a wrong URL returns a success with a body of `Redirecting...` and the queue silently never runs. This is not hypothetical: it stalled this deployment for days, wearing the exact costume of a healthy system. Point the scheduler at the origin the deployment reports as `appUrl` on `/api/health`, and alert on the status code rather than on the request failing.

## Security

- Social access tokens are encrypted at rest.
- Server-side credentials are never returned to the browser.
- Tenant/project access is scoped through the database layer and RLS.
- Instagram publishing is server-side and idempotent.
- Media must be durably accessible before production publishing.
- AI output is locally schema-validated before it can become production content.

## Product principles

FullSend does not invent product capabilities. Marketing claims must be supported by repository evidence or explicit product information. Failed jobs remain visible with their error and retry state instead of being presented as successful.
