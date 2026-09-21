# Meta App Review package

Materials for submitting FullSend's Instagram permissions to Meta App Review.

**Production host (verified live for this package):** https://full-send-lyart.vercel.app

Instagram is the only production social destination. TikTok remains in the codebase but is **not** production and is not part of this App Review submission.

## Contents

| File | Purpose |
| --- | --- |
| [permission-justifications.md](./permission-justifications.md) | Every scope in `src/lib/social/instagram-scopes.ts`, tied to user-facing features |
| [screencast-script.md](./screencast-script.md) | Owner-recorded walkthrough: connect → generate → approve → schedule → publish → analytics |
| [reviewer-instructions.md](./reviewer-instructions.md) | Step-by-step for Meta reviewers + test-user notes |
| [compliance-checklist.md](./compliance-checklist.md) | Data deletion, deauthorize, privacy, terms — with live URL checks |

Owner-only Meta Business Verification clicks live in the repo-root [`OPERATOR_ACTIONS.md`](../../OPERATOR_ACTIONS.md).

## Runtime checks (no secrets)

- `GET /api/health/meta` — public Meta readiness (presence flags, redirect URI, callback URLs, scopes, media notes)
- `GET /api/health` with cron secret — full diagnostics, including the same `meta` object

## Source of truth for scopes

`src/lib/social/instagram-scopes.ts` — OAuth dialog and this package must not drift.
