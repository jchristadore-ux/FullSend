<div align="center">

<img src="public/brand/fullsend-lockup-dark.svg" alt="FullSend" width="360">

### Everything goes live.

**You build the app. FullSend builds the audience.**

</div>

---

## 1. What FullSend is

FullSend is an autonomous marketing machine for people who have built something
and now need anyone to notice it.

You give it your app's GitHub repository. It reads the code and works out what
your product actually does, who needs it, and what is worth saying about it.
Then it builds the marketing strategy, writes the posts, makes the graphics,
connects your Instagram and TikTok, schedules everything, publishes on time,
reads the results back, and changes what it makes next based on what worked.

**One command. Everything goes live.**

It is not a marketing-plan generator — it does the work, not the planning for
the work. It is not a social-media scheduler — you do not feed it content, it
makes the content. The closest honest description is an AI marketing employee
that you turn on once.

### What it actually does, in order

| Step | What happens |
|------|--------------|
| **1. Reads your repo** | README, dependency manifest, file tree, routes, and any screenshots you have committed |
| **2. Understands the product** | Features (each with evidence), tech stack, maturity, and an explicit list of things it must never claim |
| **3. Works out the audience** | Two to four real personas with actual pain points and objections |
| **4. Builds the strategy** | Positioning, content pillars, campaigns, content mix, posting cadence, CTA strategy |
| **5. Writes the content** | Hook, script, caption, CTA, hashtags, carousel slides, video scene plans |
| **6. Makes the creative** | On-brand graphics, sized per platform, rendered to real image files |
| **7. Checks the work** | Blocks unsupported claims, spam, repetition and platform-limit violations |
| **8. Connects your accounts** | Official Instagram and TikTok APIs. No passwords, no scraping |
| **9. Publishes** | On schedule, with retries and clear failures |
| **10. Measures** | Real reach, engagement, saves, clicks — read back from the platforms |
| **11. Adjusts** | Shifts the content mix toward what is working, and tells you what it changed |

### Three things it will not do

- **It will not claim something your code cannot back up.** Quality control
  blocks unsupported claims before anything publishes.
- **It will not pretend.** If a video has not been rendered, it says so. If a
  TikTok post is restricted to you only, it says so. If a connection is broken,
  it stops and tells you rather than failing quietly.
- **It will not scrape or automate a browser** to get around a platform's
  limits. Official APIs only.

---

## 2. How to run it

You need [Node.js](https://nodejs.org) 20 or newer. Nothing else to start.

```bash
npm install
npm run dev
```

Open **http://localhost:3000**.

That's it. FullSend runs with no database, no API keys and no accounts:

- data is kept **in memory** (it disappears when you stop the server)
- sign-in uses a **local development session** (just enter an email)
- content is written by a **deterministic composer** — real, usable output
  composed from your repository by rules rather than by a language model

Every page tells you which capabilities are actually live, so you always know
what is real. Add the keys in [section 3](#3-how-to-deploy-it) to turn each one
on.

### Try the whole thing without leaving the terminal

```bash
npm run e2e
```

This runs the entire chain — repo → analysis → strategy → content → creative →
quality control → scheduling → publishing → analytics → optimization → new
content — and prints what happened at each stage.

### The other commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Start FullSend locally |
| `npm run build` | Build for production |
| `npm test` | Run the test suite |
| `npm run e2e` | Run the full end-to-end product test |
| `npm run worker` | Run background jobs as a long-lived process |
| `npm run brand` | Regenerate the logo and brand assets |
| `npm run typecheck` | Check the types |

---

## 3. How to deploy it

FullSend is built for **Vercel** (hosting) plus **Supabase** (database, sign-in
and file storage). Both have free tiers that comfortably cover getting started.

### Step 1 — Set up the database

1. Create a project at [supabase.com](https://supabase.com).
2. Open the **SQL Editor** and run the contents of
   `supabase/migrations/0001_fullsend_init.sql`. This creates every table and
   the security rules that keep customers' data separate.
3. Go to **Storage** and create a bucket called `fullsend-creative`. Make it
   **public** — Instagram and TikTok download your images from a URL, so they
   have to be able to reach them.
4. From **Project Settings → API**, copy the project URL, the `anon` key and the
   `service_role` key.

### Step 2 — Generate an encryption key

FullSend encrypts your social-media access tokens before storing them, so it
needs a 32-byte key. Any of these produce one:

- **In a terminal:**
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
- **In your browser**, from the developer console on any page (F12 → Console):
  ```js
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  ```
- **In Supabase**, in the same SQL Editor you used in step 1:
  ```sql
  select encode(gen_random_bytes(32), 'base64');
  ```

Keep it out of the repository — it belongs in Vercel's environment variables
only. Changing it later makes existing stored tokens unreadable, and every
connected account has to be reconnected.

### Step 3 — Deploy

Import the repository at [vercel.com/new](https://vercel.com/new). Vercel
detects Next.js on its own; no build settings to change. Copy `.env.example`
into Vercel's environment variables and fill in what you have. At minimum:

```
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
FULLSEND_ENCRYPTION_KEY=<the key from step 2>
NEXT_PUBLIC_SUPABASE_URL=<from step 1>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<from step 1>
SUPABASE_SERVICE_ROLE_KEY=<from step 1>
CRON_SECRET=<any long random string>
ANTHROPIC_API_KEY=<or OPENAI_API_KEY>
```

`NEXT_PUBLIC_APP_URL` has to match your real domain exactly — OAuth callbacks
and the media URLs the platforms fetch are both built from it. Set it after the
first deploy, once you know the URL, then redeploy.

### Step 4 — Make the background jobs run

This is the step people miss, and without it nothing publishes.

The schedule runs from **GitHub Actions**, not from Vercel. That is deliberate:
Vercel's free Hobby plan rejects any cron that fires more than once a day, and
it rejects it *at deploy time* — so shipping a `vercel.json` with a one-minute
schedule would stop you deploying at all. Running the schedule from Actions
means FullSend works the same on every Vercel plan.

1. In your repository: **Settings → Secrets and variables → Actions → New
   repository secret**, and add:
   - `FULLSEND_URL` — your deployed URL, e.g. `https://your-app.vercel.app`
   - `FULLSEND_CRON_SECRET` — the same value you set for `CRON_SECRET` in Vercel
2. Open the **Actions** tab and enable workflows if prompted. **FullSend
   heartbeat** then runs every five minutes.

To check it is working, open **Actions → FullSend heartbeat → Run workflow** and
pick `queue`. A green run means the schedule is live. The Control Room
(`/admin`) also shows queue depth and the oldest waiting job.

The cron endpoints refuse any request without `CRON_SECRET`, so leaving it unset
stops the jobs rather than exposing them.

#### Using Vercel's own cron jobs instead

On **Vercel Pro**, native crons are more reliable than GitHub Actions, which can
run late under load. To switch, add this to `vercel.json` and disable the
heartbeat workflow from the Actions tab so nothing runs twice:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "crons": [
    { "path": "/api/cron/queue", "schedule": "* * * * *" },
    { "path": "/api/cron/publish", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/daily", "schedule": "0 6 * * *" },
    { "path": "/api/cron/weekly", "schedule": "0 7 * * 1" },
    { "path": "/api/cron/health", "schedule": "0 */6 * * *" }
  ]
}
```

Vercel passes `Authorization: Bearer $CRON_SECRET` automatically, so the
endpoints authenticate the same way either route. **Do not add this on Hobby** —
the deploy will fail with *"Hobby accounts are limited to daily cron jobs."*

---

## 4. How to connect GitHub

**For public repositories, nothing.** Paste the URL and FullSend reads it.

For private repositories, or to avoid GitHub's anonymous rate limit, add a
personal access token:

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens).
2. Create a token with **repo** scope (classic) or read access to the
   repositories you want (fine-grained).
3. Set it as `GITHUB_TOKEN`.

---

## 5. How to configure Meta (Instagram)

Meta requires a one-time developer setup before **any** tool can publish to
Instagram. FullSend cannot do this part for you, so it does the next best
thing: **FullSend → Accounts → Instagram → Set it up** lists every step in
order, with the exact values to paste.

The short version:

1. **Switch Instagram to a Business account.** In the Instagram app:
   *Settings → Account type and tools → Switch to professional account →
   Business.* A **Creator** account will not work — Meta restricts content
   publishing to Business accounts.
2. **Link it to a Facebook Page.** Meta routes publishing through a Page, so
   this link is mandatory.
3. **Create a Meta app** at
   [developers.facebook.com](https://developers.facebook.com/apps/create/), of
   type Business, and add the **Instagram** product. Copy the App ID and App
   Secret into `META_APP_ID` and `META_APP_SECRET`.
4. **Add the redirect URI** under *Facebook Login → Settings → Valid OAuth
   Redirect URIs*:
   `https://your-app.vercel.app/api/accounts/instagram/callback`
   It must match character for character.
5. **Request the permissions** through App Review (see section 9).
6. **Connect** in FullSend → Accounts.

### What Instagram allows

| | |
|---|---|
| Publish Reels, carousels, feed posts, Stories | Yes |
| Schedule from Instagram's side | No — FullSend holds the post and publishes at the right moment |
| Read reach, likes, comments, shares, saves | Yes |
| Posts per day via the API | 100 per rolling 24 hours |
| Media | Must be at a public HTTPS URL (this is why storage is required) |

---

## 6. How to configure TikTok

Same shape: **FullSend → Accounts → TikTok → Set it up** walks it through.

1. **Register an app** at
   [developers.tiktok.com](https://developers.tiktok.com/apps). Copy the Client
   Key and Client Secret into `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.
2. **Add the Content Posting API and Login Kit** products, and enable the
   `video.publish` scope. (`video.upload` only drops drafts into the user's
   inbox — `video.publish` is what allows real posting.)
3. **Add the redirect URI**:
   `https://your-app.vercel.app/api/accounts/tiktok/callback`
4. **Verify your media domain** under *URL Prefix Verification*. TikTok
   downloads the video from your storage URL and refuses unverified domains.
5. **Submit for the content-posting audit** (section 9).
6. Once it passes, set `TIKTOK_CLIENT_AUDITED=true`.

> ### ⚠️ Read this one
>
> **Until TikTok audits your app, every post made through the API is forced to
> `SELF_ONLY` — visible only to the connected creator.** This is TikTok's rule,
> not a FullSend limitation. FullSend publishes anyway and labels each affected
> post plainly, rather than letting you believe it went live.

TikTok also needs an actual **video file**. Without a video render provider
configured, FullSend produces a complete production package — hook, scene-by-
scene timings, narration, on-screen text, music direction — and you shoot or
upload the finished video. It never claims to have rendered something it
hasn't.

---

## 7. OAuth setup

FullSend never sees or stores your social-media password. The flow is:

1. You click **Connect Instagram** (or TikTok).
2. FullSend sends you to the platform with a signed, single-use, 15-minute
   request. TikTok additionally uses PKCE.
3. You approve on the platform's own site.
4. The platform sends back a code, FullSend exchanges it for an access token,
   and stores that token **encrypted** (AES-256-GCM) in the database.

The encrypted token is bound to your specific account, so a stolen database row
cannot be replayed against a different account. Tokens are never sent to your
browser. They are refreshed automatically before they expire.

**Redirect URIs to register:**

```
https://your-app.vercel.app/api/accounts/instagram/callback
https://your-app.vercel.app/api/accounts/tiktok/callback
```

The Accounts page shows these with a copy button, filled in with your real
domain.

---

## 8. Required permissions

### Instagram

| Permission | What FullSend uses it for |
|---|---|
| `instagram_business_basic` | Read your account and username |
| `instagram_business_content_publish` | Publish posts |
| `instagram_business_manage_insights` | Read reach, likes, comments, shares, saves |
| `pages_show_list`, `pages_read_engagement` | Find the linked Facebook Page |

### TikTok

| Scope | What FullSend uses it for |
|---|---|
| `user.info.basic`, `user.info.profile`, `user.info.stats` | Read your account and follower count |
| `video.publish` | Post videos directly |
| `video.list` | Read view, like, comment and share counts |

---

## 9. Required app reviews

Both platforms review apps before allowing public posting. This is the slowest
part of setup and there is no way around it.

| | Instagram (Meta App Review) | TikTok (content-posting audit) |
|---|---|---|
| **How long** | 2–4 weeks | 2–4 weeks, usually with follow-up questions |
| **You need** | A screencast of the publishing flow, a privacy policy URL, a business use case | A recording of the full posting flow, a privacy policy URL, a finished product |
| **Before approval** | Only accounts added as app testers can connect | Every post is forced to `SELF_ONLY` |

**Start these early.** You can build everything else — analysis, strategy,
content, calendar — while you wait. FullSend generates your whole calendar
before any account is connected, precisely so the review clock is not blocking
the work.

---

## 10. Background jobs

**Your browser does not need to be open.** FullSend runs on a schedule on the
server.

| Job | How often | What it does |
|---|---|---|
| `/api/cron/queue` | every minute | Works through the job queue |
| `/api/cron/publish` | every 5 minutes | Publishes anything due |
| `/api/cron/daily` | daily | The full autopilot loop |
| `/api/cron/weekly` | weekly | The Weekly Send Report |
| `/api/cron/health` | every 6 hours | Refreshes tokens, checks connections |

The bundled **FullSend heartbeat** GitHub Actions workflow drives all of these —
see [step 4 of the deploy guide](#step-4--make-the-background-jobs-run). It works
on every Vercel plan, including the free one. On Vercel Pro you can swap to
native crons instead; the deploy guide has the config.

**Hosting elsewhere?** Either point your own scheduler at those URLs (sending
`Authorization: Bearer $CRON_SECRET`) or run `npm run worker` as a long-lived
process.

**The daily loop, in full:** check connections → check upcoming posts →
generate missing content → run quality control → publish what's due → collect
analytics → evaluate performance → identify opportunities → generate more
content → schedule it → adjust the content mix.

Every run is recorded step by step, so you can always see exactly what FullSend
did on your behalf.

> The cron endpoints **refuse every request** when `CRON_SECRET` is not set,
> rather than running unauthenticated.

---

## 11. Costs

### What FullSend costs to run

| | Free tier | Paid |
|---|---|---|
| **Vercel** | Enough for a few projects | $20/month |
| **Supabase** | 500MB database, 1GB storage | $25/month |
| **AI** | — | Roughly **$0.01–$0.05 per project per month** |
| **Instagram & TikTok APIs** | Free | Free |

**A realistic small deployment costs $0/month**, and a busy one around
$45/month plus a few cents of AI.

### Why the AI cost is so low

- **Model routing.** Simple, high-volume work goes to a cheap model. Only
  genuinely hard reasoning uses a premium one.
- **Prompt caching.** Your brand profile and product analysis are the same for
  every post, so that context is billed once and read back at a tenth of the
  price for every post after it.
- **Batching.** Ten posts are generated in one call, not ten.
- **Response caching.** Re-running analysis or regenerating a strategy for an
  unchanged repository costs nothing.

Set `FULLSEND_AI_MONTHLY_BUDGET_USD` and generation stops at that number.
Publishing of already-generated content carries on regardless.

You can see exact spend — total, per customer, per post, and cache hit rate —
in **Settings** and in the **FullSend Control Room** at `/admin`.

---

## 12. Troubleshooting

**"Instagram needs attention" / "TikTok needs attention"**
Your access token expired or was revoked. FullSend has paused publishing for
that platform and kept your posts queued. Click **Reconnect** — everything that
was waiting goes out automatically.

**"Media hosting is not configured"**
Instagram and TikTok download your images from a URL. Set the Supabase storage
variables and create a **public** bucket called `fullsend-creative`. Content
generation works without it; publishing does not.

**"This post needs a rendered video file"**
The post has a complete production package but no video file. Either shoot it
from the scene plan and upload it, or set `FULLSEND_VIDEO_PROVIDER` and
`FULLSEND_VIDEO_API_KEY` to render automatically.

**A TikTok post published but nobody can see it**
Your app has not passed TikTok's audit yet, so the post is `SELF_ONLY`. Submit
for audit, then set `TIKTOK_CLIENT_AUDITED=true`. See section 6.

**"Quality control blocked this post"**
FullSend found something it could not stand behind — usually a claim your
repository does not support ("10x faster", "50,000 users"). Open the post to see
exactly which check fired, edit it, and approve. Editing re-runs the same checks.

**Content is generated but nothing publishes**
Check, in order: is a platform connected (Accounts), is the strategy approved
(Strategy), is autopilot set to Manual (Settings), and is `CRON_SECRET` set so
the background jobs can run.

If all of those look right, the schedule itself is probably not running. Check
the **Actions** tab — the **FullSend heartbeat** workflow should show runs every
five minutes. If it is disabled, or its two secrets are missing, posts sit in
the queue looking correct while their send time passes. See
[step 4](#step-4--make-the-background-jobs-run). The Control Room at `/admin`
confirms it either way: a growing queue with an old "oldest queued job" means
nothing is draining it.

**Vercel says "Hobby accounts are limited to daily cron jobs" and won't deploy**
Something has added a `crons` block back into `vercel.json`. The shipped file
has none, precisely so free-tier deploys work — the schedule runs from GitHub
Actions instead. Remove the block, or upgrade to Pro if you want native crons.

**Data disappeared after a restart**
You are on the in-memory store. Add the Supabase variables and run the
migration. Settings shows which driver is active.

**"Monthly AI budget reached"**
Raise `FULLSEND_AI_MONTHLY_BUDGET_USD` or wait for the next month. Already-
generated content keeps publishing.

**GitHub rate limit**
Set `GITHUB_TOKEN`. Anonymous requests are limited to 60 per hour.

**Something else**
The **FullSend Control Room** at `/admin` shows every unresolved failure with
its cause and its fix, plus the job queue, API usage and platform health.

---

## For developers

### The stack

Next.js (App Router) · React · TypeScript · Tailwind CSS · Supabase
(Postgres + Auth + Storage) · Vercel · Anthropic / OpenAI · official Meta and
TikTok APIs · Stripe-ready.

### Layout

```
src/
  app/                     Pages and API routes
  components/              UI
  lib/
    ai/                    Provider abstraction, routing, caching, cost ledger
    analysis/              Product understanding
    analytics/             Metric collection, the Send Score
    automation/            The autopilot loop, weekly report
    brand/                 Brand system and the logo generator
    content/               The content machine, mix planning, dedup
    creative/              Graphic rendering and media hosting
    db/                    Store interface, Supabase + memory drivers
    github/                Repository reading
    jobs/                  Queue and worker
    optimizer/             Performance analysis and acting on it
    publish/               Publishing pipeline
    qc/                    Quality control
    scheduler/             Calendar and scheduling
    social/                Instagram, TikTok and mock adapters
    strategy/              Strategy and brand profile generation
    trends/                Trend signals
    video/                 Video production packages
supabase/migrations/       Schema and row-level security
scripts/                   E2E test, worker, brand assets, dev fixtures
tests/                     Test suite
```

### Testing

```bash
npm test     # 124 tests
npm run e2e  # the full chain, printed stage by stage
```

Tests run entirely in-process against the memory store, the deterministic
composer and mock platform adapters — no network, no keys, no fixtures to
maintain.

### Security

Tokens encrypted at rest with AES-256-GCM and bound to their account · OAuth
state signed and expiring · PKCE for TikTok · row-level security in Postgres
plus tenant scoping in the data layer · rate limiting on every expensive
endpoint · audit logging · secrets never sent to the browser · credentials
redacted from logs.

---

<div align="center">

**BUILD ONCE. MARKET FOREVER.**

</div>
