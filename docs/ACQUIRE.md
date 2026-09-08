# Listing FullSend on Acquire.com

Short pointer for preparing an [Acquire.com](https://acquire.com) listing. Pair this with `docs/TRANSFER.md` for technical handoff.

## How to list (high level)

1. Create a seller account on Acquire.com and start a new listing for a SaaS / micro-SaaS.
2. Use listing copy themes below — stay accurate; Instagram-first, young product.
3. Attach a **data room** (private) with financials and metrics; do not commit those files to this repo.
4. Point serious buyers at `docs/TRANSFER.md` (and the APA at closing) for how ownership transfers.

## Listing copy themes

- **One-liner:** Autonomous marketing machine for app founders — connect GitHub, ship Instagram content end-to-end.
- **Positioning:** Instagram-first content → creative → schedule → durable publish → analytics. Not a generic “all socials” tool.
- **Stack story:** Next.js / Vercel / Supabase / Stripe / Meta — modern, transferable, documented.
- **Honesty:** Young SaaS; TikTok and extra platforms are roadmap / optional, not production claims.
- **Buyer value:** Durable job worker, verified product intelligence from the repo, Stripe billing already wired.

Adapt tone to Acquire’s listing fields ( Traction, Tech, Reason for sale, etc.). Prefer under-claim over hype.

## Must-have data room (owner-side)

Keep these **out of git**. Share via Acquire’s secure attachments or a private folder:

| Item | Why |
| --- | --- |
| **P&L** (or simple income/expense) | Valuation and diligence |
| **Stripe metrics** | MRR/ARR, churn, active subs, refunds — export from Stripe Dashboard |
| **Traffic / product usage** | Vercel analytics, app signups, publish volume if available |
| **Transition guide** | This repo’s `docs/TRANSFER.md` plus a private credential runbook |
| **Customer / support notes** | Outstanding tickets, known bugs, Meta App Review status |

Financials and P&L remain **owner-side**; the PR that added these docs does not include numbers.

## Honest positioning checklist

- [ ] Lead with Instagram; mention TikTok only as optional / not audited for public posting.
- [ ] Call it a young SaaS — early traction language only if metrics support it.
- [ ] Do not invent ARR or user counts in the listing or in this repo.
- [ ] State that rights transfer via the Asset Purchase Agreement at closing; the repo `LICENSE` is proprietary until then.

## Related

- `docs/TRANSFER.md` — ordered handoff and verification
- `LICENSE` — all rights reserved pending sale
- `.env.example` — env var names and setup commentary (no secrets)
