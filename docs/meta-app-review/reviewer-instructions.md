# Meta reviewer — step-by-step instructions

**App:** FullSend  
**Production URL:** https://full-send-lyart.vercel.app  
**Platform under review:** Instagram (Instagram API with Instagram Login)  
**TikTok:** Not part of this submission / not production.

Provide these steps (and test-user credentials) in the App Review "Instructions" field. Adjust emails/usernames to the test users you add under App Roles.

---

## Test users

| Role | What to provide Meta |
| --- | --- |
| FullSend login | Email that can receive a magic-link sign-in for the demo project |
| Instagram | Username + password for an Instagram **Business** account that is an **Instagram tester** on this Meta app (required while App Mode is Development) |

**Notes for Meta:**

1. Sign-in is **email magic link** (no password on FullSend). Use the inbox you share with the reviewer, or paste a fresh link if your process allows.
2. The Instagram account must be **Business** (not Creator) — Meta restricts content publishing to Business accounts.
3. While the app is in Development Mode, the Instagram account must accept the **Instagram tester** invite: Instagram → Settings → Website permissions → Apps and websites → Tester invites.

---

## Steps for the reviewer

1. Open https://full-send-lyart.vercel.app and sign in with the provided test email (magic link).
2. Open the prepared demo project (or the only project on the account).
3. Go to **Accounts** → **Connect Instagram**. Approve the three permissions when Meta prompts:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_insights`
4. Go to **Content**. Open a draft post (or trigger **Generate content** and wait for a draft).
5. **Approve** the post.
6. **Schedule** it from the content detail or **Calendar** (a time a few minutes ahead is fine).
7. Wait for publish (or use send-now if shown). Confirm status becomes **Published** and open the Instagram permalink.
8. Open **Analytics** and confirm the insights UI loads for the connected account / posts.

### Compliance URLs (also in App settings)

| Purpose | URL |
| --- | --- |
| Privacy Policy | https://full-send-lyart.vercel.app/privacy |
| Terms of Service | https://full-send-lyart.vercel.app/terms |
| Data deletion instructions | https://full-send-lyart.vercel.app/data-deletion |
| Deauthorize callback | https://full-send-lyart.vercel.app/api/accounts/instagram/deauthorize |
| Data deletion callback | https://full-send-lyart.vercel.app/api/accounts/instagram/data-deletion |
| OAuth redirect | https://full-send-lyart.vercel.app/api/accounts/instagram/callback |
| Meta readiness (no secrets) | https://full-send-lyart.vercel.app/api/health/meta |

---

## Expected permissions justification (short)

FullSend is an autonomous marketing engine for app founders. It connects one Instagram Business account per brand, generates product-aware posts, lets the founder approve, schedules server-side, publishes via the Content Publishing API, and reads insights to improve later posts. It does not use Instagram for messaging, ads, or scraping unrelated users.
