# Permission-by-permission justifications

Source of truth: `src/lib/social/instagram-scopes.ts`.

Default login mode is **Instagram Login** (`META_LOGIN_MODE=instagram_login`, the production default). That path requests the three `instagram_business_*` permissions below.

The Facebook Login list is retained for `META_LOGIN_MODE=facebook_login` only. Several of those names were retired by Meta on 27 January 2025 — **do not submit App Review for the Facebook Login list unless you have re-confirmed each permission still exists for your app.** Prefer submitting Advanced Access for the Instagram Login scopes.

---

## A. Instagram Login scopes (default — submit these)

### `instagram_business_basic`

| | |
| --- | --- |
| **User-facing feature** | **Connect Instagram** on `/app/accounts` (and onboarding). After OAuth, FullSend shows the connected Business account's username, display name, avatar, and account id so the operator knows which brand is linked. |
| **Why required** | Identify the Instagram Professional account the user authorized and store `external_id` / profile fields on `social_accounts`. Without this, Connect cannot complete or display the linked account. |
| **Where in product** | Accounts page connection card; project destination picker when approving/scheduling content. |
| **API use** | Profile / account identity calls after token exchange (`InstagramAdapter` account resolution). |

### `instagram_business_content_publish`

| | |
| --- | --- |
| **User-facing feature** | **Publish** Instagram Reels, carousels, feed posts, and Stories from FullSend — either immediately after approval or when a scheduled post becomes due. |
| **Why required** | Create media containers and call media publish on the connected IG user. This is the core product: autonomous marketing that actually goes live. |
| **Where in product** | Content detail → Approve; Calendar / Send Center scheduling; background worker publish jobs; autopilot modes (Manual / Hybrid / Full Send) on Settings. |
| **API use** | `POST /{ig-user-id}/media`, container status poll, `POST /{ig-user-id}/media_publish` (see `src/lib/social/instagram.ts`). Media must be at a public HTTPS URL (Supabase `fullsend-creative` bucket). |

### `instagram_business_manage_insights`

| | |
| --- | --- |
| **User-facing feature** | **Analytics** on `/app/analytics` and post-level metrics used to score what worked and feed the next content cycle. |
| **Why required** | Read reach, likes, comments, shares, saves, views, and related insights for published media and account-level day metrics. |
| **Where in product** | Analytics dashboard; weekly report; autopilot "collect analytics" step; Send Score / performance used for optimization. |
| **API use** | `GET /{media-id}/insights` and `GET /{ig-user-id}/insights` in `InstagramAdapter.getPostMetrics` / `getAccountMetrics`. |

---

## B. Facebook Login scopes (legacy path only — not the default submission)

These appear in `INSTAGRAM_SCOPES_FACEBOOK_LOGIN`. FullSend only requests them when `META_LOGIN_MODE=facebook_login`.

### `instagram_basic` (retired name — do not request in new reviews)

| | |
| --- | --- |
| **Historical feature mapping** | Same as `instagram_business_basic`: show connected IG profile after Facebook Login + Page linkage. |
| **Review note** | Meta replaced this with `instagram_business_basic`. Submitting the old name wastes a review cycle. |

### `instagram_content_publish` (retired name — do not request in new reviews)

| | |
| --- | --- |
| **Historical feature mapping** | Same as `instagram_business_content_publish`: publish media containers. |
| **Review note** | Replaced by `instagram_business_content_publish`. |

### `instagram_manage_insights`

| | |
| --- | --- |
| **User-facing feature** | Same analytics surfaces as `instagram_business_manage_insights`. |
| **Why required (facebook_login only)** | Insights on IG media when the token was obtained via Facebook Login / Page token path. |

### `pages_show_list`

| | |
| --- | --- |
| **User-facing feature** | During Facebook Login connect, list Facebook Pages the user manages so FullSend can select the Page linked to the Instagram Business account. |
| **Why required (facebook_login only)** | Facebook Login does not attach an IG user directly; Page listing is how the adapter discovers the linked Instagram professional account. |
| **Not used when** | `instagram_login` (default) — no Page picker in the happy path. |

### `pages_read_engagement`

| | |
| --- | --- |
| **User-facing feature** | Read Page-linked engagement metadata needed to resolve and maintain the IG Business account relationship under Facebook Login. |
| **Why required (facebook_login only)** | Supports Page ↔ Instagram linkage checks during connect and publish token selection. |
| **Not used when** | Default Instagram Login. |

### `business_management`

| | |
| --- | --- |
| **User-facing feature** | Manage / select Business Manager assets when connecting via Facebook Login for Business (multi-asset businesses). |
| **Why required (facebook_login only)** | Some Business Manager setups require this to list manageable Pages/IG assets the user is allowed to authorize. |
| **Not used when** | Default Instagram Login. Prefer not requesting this for the Instagram Login App Review. |

---

## What we are **not** requesting

- Messaging, inbox, or comment-moderation permissions
- Ads / Marketing API permissions
- User friends, email, or public_profile beyond what Instagram Login already returns for the professional account
- TikTok scopes (out of scope for this Meta submission; TikTok is not production)
