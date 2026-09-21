# Screencast script (owner records)

Record a single continuous desktop (or mobile browser) video for Meta App Review. Narrate briefly or use on-screen captions. Show the **real** FullSend UI on https://full-send-lyart.vercel.app (or the deployment under review).

**Target length:** 3–8 minutes.  
**Account:** Instagram **Business** test account that is either an App Role tester (Development Mode) or can authorize the Live app.

---

## 0. Before you hit record

1. Sign in to FullSend with the reviewer test email (magic link).
2. Open a project that already has product analysis + an approved strategy (or be ready to skip to content that already exists).
3. Confirm Accounts does **not** already show the demo IG account connected — or disconnect it first so Connect is visible.
4. Have the Instagram Business credentials ready in a password manager (do not type secrets slowly on camera if avoidable — paste is fine).

---

## 1. Connect Instagram Business (~60–90s)

1. Go to **Accounts** (`/app/accounts`).
2. Click **Connect Instagram**.
3. Complete Meta's OAuth consent — show the permission screen listing:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_insights`
4. Land back in FullSend. Point at the connected account card (username / avatar / status connected).

**Say / caption:** "This is how a founder links their Instagram Business account. FullSend stores an encrypted token and only uses it to publish and read insights."

---

## 2. Generate content (~45–60s)

1. Open **Content** (`/app/content`) or the project home Send Center.
2. Trigger generation if needed (e.g. **Generate content** / run pipeline) — or open an existing draft if generation is slow.
3. Open one content item that has a caption + creative preview.

**Say / caption:** "FullSend drafts Instagram posts from the product. The founder always reviews before anything public goes out in Manual mode."

---

## 3. Approve (~30–45s)

1. On the content detail page, click **Approve** (or equivalent approval control).
2. Show status change to approved / ready to schedule.

**Say / caption:** "Approval is the human gate. In Manual mode nothing publishes without this step."

---

## 4. Schedule (~30–45s)

1. Open **Calendar** (`/app/calendar`) or schedule controls on the content item.
2. Set or show a scheduled time (can be a few minutes ahead for the demo).
3. Confirm the item appears as **Scheduled**.

**Say / caption:** "FullSend schedules server-side — Instagram has no native schedule API in this flow."

---

## 5. Publish (~60–90s)

**Option A (best for review):** Wait for the due time and show the worker/cron publish the post (status → publishing → published), then open the Instagram permalink.

**Option B (if timing is tight):** Use an immediate publish / "send now" control if present in the UI for approved content, and show the resulting **Published** state + permalink.

1. Show FullSend status **Published**.
2. Open the live Instagram post in a browser tab (permalink).

**Say / caption:** "Publishing uses Instagram Content Publishing. Media is fetched by Meta from our public HTTPS creative URL."

---

## 6. Analytics (~45–60s)

1. Open **Analytics** (`/app/analytics`).
2. Show metrics for the account and/or the post just published (reach, likes, comments, etc. — zeros are OK if the post is brand new; show the UI that will fill in).
3. Optionally show that collection is part of the ongoing automation loop.

**Say / caption:** "Insights permissions let FullSend measure what worked and improve the next batch."

---

## 7. Optional closer (~20s)

1. Briefly open `/privacy` and mention data use is limited to publishing and measurement.
2. Stop recording.

---

## Upload notes for Meta

- Preferred: MP4, clear 1080p, no background music that drowns narration.
- If Development Mode: state in the review notes that the demo user is an **Instagram tester** on the app.
- Do **not** show `.env`, Vercel env, App Secret, or encryption keys.
