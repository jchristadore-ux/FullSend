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
npm test
npm run build
npm run e2e
npm run worker
```

## Deployment

FullSend uses Next.js/Vercel for the application and Supabase for persistence, authentication, and media storage.

Run the database migrations in `supabase/migrations/` in order. The creative-storage migration creates the public `fullsend-creative` bucket required for Instagram media delivery.

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

## Security

- Social access tokens are encrypted at rest.
- Server-side credentials are never returned to the browser.
- Tenant/project access is scoped through the database layer and RLS.
- Instagram publishing is server-side and idempotent.
- Media must be durably accessible before production publishing.
- AI output is locally schema-validated before it can become production content.

## Product principles

FullSend does not invent product capabilities. Marketing claims must be supported by repository evidence or explicit product information. Failed jobs remain visible with their error and retry state instead of being presented as successful.
