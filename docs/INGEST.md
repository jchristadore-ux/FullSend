# Signed ingest API — The Brovisional → FullSend

The Brovisional (golf handicap app, `jchristadore-ux/brovisional`) renders
Instagram cards and pushes them into FullSend as posts. FullSend is the only
system that holds Meta tokens and publishes; Brovisional never talks to Meta.

Ingested posts are ordinary FullSend posts: they appear in the **Send Center**
(Content), are approved there, and publish through the same durable
`publish_post` jobs, publish guard and Instagram adapter as everything else.

## Endpoints

| Method | URL |
| --- | --- |
| `POST` | `https://full-send-lyart.vercel.app/api/ingest/posts` |
| `DELETE` | `https://full-send-lyart.vercel.app/api/ingest/posts/{idempotency_key}` |

`{idempotency_key}` may be sent raw (`brovisional:round_result:r_123`) or
URL-encoded (`brovisional%3Around_result%3Ar_123`).

## Authentication

Every request carries:

```
X-Brovisional-Timestamp: <unix seconds>
X-Brovisional-Signature: sha256=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
```

- The HMAC is computed over the **raw request body bytes exactly as sent**
  (UTF-8). FullSend verifies before parsing JSON, so do not re-serialise
  after signing.
- `DELETE` has an empty body, so the signed string is `${timestamp}.`.
- The timestamp must be within **300 seconds** of FullSend's clock (either
  direction).
- Comparison is constant-time. FullSend accepts `BROVISIONAL_INGEST_SECRET`
  and, during a rotation, `BROVISIONAL_INGEST_SECRET_PREVIOUS`.

Node example:

```ts
import { createHmac } from 'node:crypto';
const body = JSON.stringify(payload);
const ts = Math.floor(Date.now() / 1000).toString();
const sig = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
await fetch('https://full-send-lyart.vercel.app/api/ingest/posts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Brovisional-Timestamp': ts, 'X-Brovisional-Signature': sig },
  body,
});
```

## `POST /api/ingest/posts` body

```jsonc
{
  "project": "brovisional",                         // only accepted value
  "event_type": "round_result",                     // | "handicap_drop" | "weekly_leaderboard" | "marketing"
  "idempotency_key": "brovisional:round_result:r_123", // must start with brovisional:<event_type>:
  "image_url": "https://…/card.png",                // public https, 1080x1350 PNG
  "alt_text": "Scorecard: Mike R. shot 78 at Pine Hollow.", // 1–1000 chars
  "caption_hint": "Big day at Pine Hollow.",        // optional, ≤1500 chars
  "facts": {
    "players": [{ "display_name": "Mike R." }],     // display names only
    "course": "Pine Hollow",
    "score": 78,
    "differential": 6.4,
    "index": 9.8,
    "delta": -0.6,
    "leaderboard": [                                // weekly_leaderboard
      { "rank": 1, "display_name": "Jo", "index": 8.1, "delta": -1.0 }
    ]
  },
  "brand": { "primary": "#0B6E4F", "accent": "#F2C14E", "logo_url": "https://…/logo.png" },
  "scheduled_for": "2026-10-05T13:00:00-04:00",    // optional ISO-8601 with offset (or null)
  "group_id": "grp_2026w40"                          // required, ≤200 chars
}
```

Validation (zod, `src/lib/ingest/schema.ts`):

- `idempotency_key` matches `^brovisional:(round_result|handicap_drop|weekly_leaderboard|marketing):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`
  and its event segment must equal `event_type`.
- `facts` is required for `round_result`, `handicap_drop` and
  `weekly_leaderboard`; it may be omitted or `{}` for `marketing` (see below).
- `image_url` and `brand.logo_url` must be `https://`. `brand.primary` /
  `brand.accent` are hex colours.
- `facts` is a **closed** shape. Every field is optional (`players` defaults to
  `[]`); numbers must be finite; display names are 1–80 chars. **Unknown keys
  are silently dropped and never stored** — send only display names and golf
  numbers.
- Body ≤ 256 KB.

### What FullSend does with it

1. Resolves `project: "brovisional"` to the FullSend project in
   `BROVISIONAL_PROJECT_ID`.
2. Downloads `image_url` (https only, public addresses only, ≤10 MB, 15 s,
   ≤3 redirects each re-checked), checks it is a PNG/JPEG/WebP with an
   Instagram feed aspect ratio (4:5 … 1.91:1), re-encodes it as JPEG
   (Instagram feed images must be JPEG; transparency is flattened onto
   `brand.primary`) and stores it in FullSend's Supabase creative bucket.
   Instagram fetches **our** copy at publish time.
3. Builds the caption deterministically: `caption_hint`, then a facts line
   (e.g. `Mike R. shot 78 at Pine Hollow · differential 6.4 · index 9.8 (−0.6).`,
   or the top 10 leaderboard rows), plus `#golf #handicap #TheBrovisional`.
   The AI copywriter is deliberately **not** used: it enriches from product
   data, and these posts are about real people. Only `facts` display names
   are ever used. The caption is run through FullSend's normal quality
   control.
4. `alt_text` is stored on the creative and sent to Instagram as the image's
   `alt_text` when it publishes.
5. Creates a content item (`origin: ingest`, format `static`, Instagram) with
   that one creative.
   - **Auto-publish off (default):** status *Approval required* — it waits in
     the Send Center for JD. Response `draft`. Its time is `scheduled_for`, or
     the project's next open calendar slot (else now); approving it puts it on
     the calendar at that time (or immediately if that time has passed).
   - **Auto-publish on** (`projects.ingest_auto_publish`, Settings toggle):
     approved and scheduled straight away at `scheduled_for`, or the next open
     slot in the coming week, or now. Response `scheduled`. If quality control
     blocks it or the plan's post allowance is used up, it is held as a draft
     instead (response `draft`).

### Marketing posts (`event_type: "marketing"`)

Twice-daily promo cards for The Brovisional itself.

```jsonc
{
  "project": "brovisional",
  "event_type": "marketing",
  "idempotency_key": "brovisional:marketing:2026-10-05:am",   // <YYYY-MM-DD>:<am|pm>
  "image_url": "https://…/promo.png",                        // required, same image rules
  "alt_text": "The Brovisional app showing a group leaderboard.",
  "caption_hint": "Your Saturday group deserves real handicaps.", // required, ≥10 chars: this IS the copy
  "brand": { "primary": "#0B6E4F", "accent": "#F2C14E" },
  "scheduled_for": "2026-10-05T11:30:00-04:00",
  "group_id": "marketing-2026-10-05"
  // "facts" may be omitted or {} — and is ignored if sent
}
```

- **Caption** = `caption_hint`, then
  `Track your crew’s handicaps on The Brovisional — link in bio (brovisional.vercel.app).`
  (skipped if the hint already says "link in bio"; Instagram captions can't
  carry clickable links), then `#golf #handicap #TheBrovisional`. No names
  are used, and any `facts` sent are ignored.
- The **hook** is the first line of the hint that is at least 5 characters.
- Marketing posts follow the same per-project **auto-publish** toggle. With it
  on and `scheduled_for` set, the post is scheduled at **exactly** that
  instant (a past time means now) and goes out on the next worker pass. Daily
  caps and quiet hours apply only to FullSend choosing a slot, never to an
  explicit `scheduled_for`.
- **Quality control** runs as usual, but only a *block* finding holds a post
  as a draft (claims like "#1"/"guaranteed", an empty caption, placeholders,
  over-length). Warnings (e.g. an unqualified "free", "limited time") go
  through. Ingested posts are **not** compared with recent posts, so a
  near-identical promo every day is not held as a repeat; idempotency is by
  key, not by caption similarity.
- **Plan allowance:** auto-publish checks the project owner's monthly post
  allowance. Operators (`FULLSEND_ADMIN_EMAILS` or `users.is_admin`) are
  uncapped, so two a day is fine for JD. On a paid plan, Send (60/month) does
  not cover 2×31 days; Full Send (1000) does. With billing off (no
  `STRIPE_SECRET_KEY`) there is no cap.
- `DELETE /api/ingest/posts/brovisional:marketing:2026-10-05:am` withdraws it
  like any other post.

### Idempotency

- The same `idempotency_key` sent again **updates the existing post** (image,
  caption, alt text, time) and responds `updated`. It never creates a
  duplicate — enforced by the database (`content_items.dedup_hash =
  'ingest:<key>'`, unique per project).
- A resend whose image, caption, alt text and time are all unchanged is a
  no-op (`updated`), so retries never disturb an approved post.
- A changed resend of a post that was approved/scheduled goes back to
  *Approval required* when auto-publish is off (JD re-approves what changed),
  or is re-scheduled when auto-publish is on.
- Once published: responds `published` with the same `post_id` and changes
  nothing.

## `DELETE /api/ingest/posts/{idempotency_key}`

Withdraws an unpublished draft or scheduled post: removes the post, its
schedule, any queued publish job and the stored image.

## Responses

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{ status: "draft" \| "scheduled" \| "updated" \| "published", post_id, review_url }` | POST accepted. `review_url` = `https://full-send-lyart.vercel.app/app/content/<post_id>` (JD's sign-in required). |
| 200 | `{ status: "withdrawn", post_id }` | DELETE succeeded. |
| 400 | `{ error, details, retryable: false }` | `validation_failed` (details = `[{path, message}]`), `invalid_json`, `invalid_image_url`, `invalid_image`, `image_unavailable`, `image_too_large`, `unexpected_body`. Fix and resend. |
| 401 | `{ error, details, retryable: false }` | `missing_headers`, `malformed_timestamp`, `stale_timestamp`, `malformed_signature`, `invalid_signature`. |
| 404 | `{ error: "not_found", … }` | DELETE: nothing with that key (already withdrawn or never sent) — treat as done. |
| 409 | `{ error: "already_published" \| "publish_in_progress", … }` | DELETE of a published post, or one Instagram is publishing right now. |
| 413 | `{ error: "payload_too_large", … }` | Body > 256 KB. |
| 429 | `{ error: "rate_limited", … }` + `Retry-After` | Retry after the given seconds. |
| 5xx | `{ error, details, retryable: true }` | Retry with the same key (backoff). Includes `ingest_not_configured` (503, secret or project id not set yet), `publish_in_progress` (503, POST while publishing), `storage_unavailable`, `image_fetch_failed` (502, your image host failed), `concurrent_request` (503). |

## Rate limits

- 60 requests/minute per client IP before the signature is checked.
- 120 requests/minute for Brovisional after the signature is checked.

(In-process limiter, `src/lib/rate-limit.ts`, per serverless instance.)

## Environment variables (FullSend, Vercel)

| Name | Set by | Value |
| --- | --- | --- |
| `BROVISIONAL_INGEST_SECRET` | Brovisional side | Shared HMAC secret (same value in Brovisional). |
| `BROVISIONAL_INGEST_SECRET_PREVIOUS` | Optional, during rotation | The old secret; clear once Brovisional has switched. |
| `BROVISIONAL_PROJECT_ID` | JD / operator | UUID of the FullSend project for The Brovisional (Settings → "Project ID"). |

Existing variables it relies on: `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` (default
`fullsend-creative`), `NEXT_PUBLIC_APP_URL` (used for `review_url`).

## Database

Migration `supabase/migrations/0008_ingest_auto_publish.sql` adds
`projects.ingest_auto_publish boolean not null default false`. Until it is
applied, ingest still works and everything lands as a draft (the toggle reads
as off and cannot be saved).

## Privacy and logging

- Only display names and golf numbers from `facts` are used; nothing is looked
  up or enriched. Unknown `facts` keys are discarded before storage.
- Logs record event type, idempotency key, post id and outcome — never
  secrets, signatures or headers.

## Code

- `src/lib/ingest/signature.ts` — HMAC verify (current + previous secret)
- `src/lib/ingest/schema.ts` — zod contract
- `src/lib/ingest/caption.ts` — deterministic, privacy-safe caption
- `src/lib/ingest/image.ts` — guarded download + JPEG normalisation
- `src/lib/ingest/service.ts` — create / update / schedule / withdraw
- `src/lib/ingest/http.ts` — request handling, error shape, rate limits
- `src/app/api/ingest/posts/route.ts`, `src/app/api/ingest/posts/[idempotency_key]/route.ts`
- `tests/ingest.test.ts`
