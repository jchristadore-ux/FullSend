# Compliance checklist (Meta App Review)

Checked against production host **https://full-send-lyart.vercel.app** on **20 Sep 2026, ~11:59 PM ET** (America/New_York).

| Requirement | URL / location | Live check | Result |
| --- | --- | --- | --- |
| Privacy Policy URL | https://full-send-lyart.vercel.app/privacy | HTTP 200, HTML policy with contact email | **Verified live** |
| Terms of Service URL | https://full-send-lyart.vercel.app/terms | HTTP 200, HTML terms with contact email | **Verified live** |
| User-facing data deletion instructions | https://full-send-lyart.vercel.app/data-deletion | HTTP 200; documents disconnect, delete project, delete account | **Verified live** |
| Deauthorize callback | `POST` https://full-send-lyart.vercel.app/api/accounts/instagram/deauthorize | Without `signed_request` → HTTP 400 `missing_signed_request` | **Verified live** (route deployed; signature path covered by unit tests) |
| Data deletion callback | `POST` https://full-send-lyart.vercel.app/api/accounts/instagram/data-deletion | Without `signed_request` → HTTP 400 `missing_signed_request` | **Verified live** (route deployed; returns `url` + `confirmation_code` when signed — unit/integration tests in repo) |
| Data deletion status page | https://full-send-lyart.vercel.app/data-deletion?code=… | Same page as instructions; code is informational | **Verified live** (page loads) |
| OAuth redirect URI | https://full-send-lyart.vercel.app/api/accounts/instagram/callback | Must match Meta app Instagram Login settings exactly | **Expectation documented**; paste confirmation in Meta dashboard is **owner-only** (see OPERATOR_ACTIONS.md) |
| Contact email on legal pages | `FULLSEND_CONTACT_EMAIL` | Privacy/terms/data-deletion show `jchristadore@gmail.com` | **Verified live** |
| Public health (no secrets) | https://full-send-lyart.vercel.app/api/health | `{"ok":true,"appUrl":"https://full-send-lyart.vercel.app","problems":[]}` | **Verified live** |
| Meta readiness endpoint | `/api/health/meta` | Added in this workstream | **Code complete — live after deploy** |

## Implementation references

| Concern | Code |
| --- | --- |
| Deauthorize | `src/app/api/accounts/instagram/deauthorize/route.ts` |
| Data deletion callback | `src/app/api/accounts/instagram/data-deletion/route.ts` |
| Shared revoke logic | `src/lib/social/meta-callbacks.ts` (`revokeInstagramFor`) |
| `signed_request` verify | `src/lib/social/signed-request.ts` |
| Tests | `tests/meta-callbacks.test.ts` |

## Owner must still paste in Meta dashboard

These cannot be verified from the public site alone:

1. App settings → Basic → Privacy Policy URL, Terms URL, Data Deletion Request URL / callback.
2. App settings → Basic (or Facebook Login / Instagram product) → Deauthorize Callback URL.
3. Instagram → API setup with Instagram login → OAuth redirect URIs.
4. Business Verification (if requesting Advanced Access for third-party accounts) — see `OPERATOR_ACTIONS.md`.

## Explicit non-goals

- No invented ARR, user counts, or traction claims in review text.
- TikTok is not part of this Meta submission.
