# Handoff v3 — MINDMERC: Search & Deploy — Reddit First-Offer Pipeline
This supersedes any earlier version of this doc. Read fully before acting. Use computer-use/browser automation to actually complete signups and clicks — don't just describe steps back.

## Live status — update this before you stop, every time
Overwrite this block after completing any step. A fresh instance in a new session/account reads only this section to know exactly where to pick up — don't make it guess.
- Last updated: [date/time]
- Which lifecycle phase is this session: [Phase 1 — building MSD itself / Phase 2 — building one queued Solution]
- Reddit client ID/secret: [provided by Cj directly this session — not stored in this file]
- Cloudflare / Supabase / Telegram / Gemini provisioning: [status of each]
- Worker (MSD) deployed: [yes/no, URL]
- End-to-end test (search → triage → queue write): [pass/fail, details]
- Blockers right now: [specific]

## Victory Objective (read first, keep every decision aligned to this)
The business model, verbatim: **Find need. Build Solution. Fill need with Solution. Reach out and offer the full-but-time-limited version (the demo) for a steal price they can't say no to, having their Solution already in hand. Collect payment. Repeat.**
Do everything, end to end, such that the person with the need cannot reasonably say anything but an immediate "yes."

## Terminology — read once, don't get this confused
**MSD (MINDMERC: Search & Deploy) is a Cloudflare Worker. It is NOT an AI agent and has zero build capacity.** It's lightweight serverless plumbing: it searches, triages, prices, drafts, routes for approval, and sends — via API calls to Reddit, Gemini, Telegram, and Supabase. It cannot write, compile, or host a custom app. Building each Delivered Solution (DS) is a completely separate job, done in separate PxC sessions — see below.

## Operator context
- Reddit account: brand new, 0 karma, username **MINDMERC**.
- Reddit client ID/secret: Cj registers the app and obtains these himself, manually, before Phase 1 starts. He provides them directly in the session — never generate or attempt Reddit app registration yourself.
- Non-coder. This is exactly why Solution-building lives in its own supervised PxC sessions, not in unattended Worker code.
- Budget: $0. Every tool in this stack must be free tier, even if only usable for a few days.

## Lifecycle — two phases, don't conflate them
1. **Phase 1 (once)**: A PxC session builds and deploys MSD (the Worker) itself — Cloudflare, Supabase, Telegram bot, Gemini key, Reddit search wired up. Once deployed, MSD runs on its own, permanently, on Cloudflare's cron — no PxC session is needed to keep it running.
2. **Phase 2 (repeated, one at a time, as needed)**: MSD finds and triages leads on its own and queues Bucket-A ones (see queue below). Separately, whenever there's a queued lead, Cj opens a fresh PxC session, pastes this file, and that session builds exactly **one** Solution for exactly **one** queued lead, writes the result back to the queue, and stops. It does not touch MSD's code.

## Stage 1 — Search (defined subreddit list — Reddit's API approval process requires this, not sitewide)
Use Reddit's search API scoped to the approved subreddit list from the app's API registration (starting set: r/smallbusiness, r/Entrepreneur, r/forhire, r/slavelabour, r/webdev, r/SaaS, r/startups, r/freelance). This isn't a self-imposed limit — Reddit's app-approval form requires declaring the target subreddits, so search must stay within whatever was declared there. Expanding later means updating the registration, not just widening the query.

## Stage 2 — Need + urgency extraction
For each post + its comment replies, extract:
- The implied Delivered Solution (DS) need — what would actually solve their stated problem.
- An urgency/desperation score. **Ranking of evidence, high to low:**
  1. Plainly stated fact: "I need X and I'll pay $Y for it."
  2. Plainly stated need without a number.
  3. Context/tone/implication-derived signals (word choice, replies to their own comments, repeated frustration).
  Weight accordingly. Note explicitly: a reply like "$3,000 sounds more reasonable" is *not* proof of an actual budget or readiness to pay — flag it as inferred, not confirmed.

## Stage 3 — Feasibility triage (highest-uncertainty step — be conservative)
Classify each extracted DS need into exactly one bucket:
- **A — Buildable now**: achievable in a single focused PxC session as a working, demoable, time/use-limited product (web app, script, automation/workflow, browser extension, chatbot, admin portal, small game, even a full small site — no size limit as long as one session can finish it). These get written to the **Leads needing Solutions** queue below.
- **B — Buildable, but needs Cj's high-end PC / paid cloud compute**. Logged separately, reported to Cj, not queued for PxC — he'll action these once compute is available.
- **C — Not buildable in this model at all** (regulated/certified software, physical/on-site service, needs enterprise data access, etc.). Discard.
Be conservative — a false "yes, buildable" call is worse than passing on a lead.

**Priority score, for every Bucket A lead (this is a rough pass, not final pricing)**: combine the Stage 2 urgency/desperation score with a rough estimated offer value using the same Marie's Rule underbid logic from Stage 5 (lowest visible/inferable number, positioned below it) — but skip the $20/hr floor check here, since no build hours exist yet. Write this as a single 1–5 priority number (5 = most urgent + highest estimated value) into the queue. This is what determines which lead a Phase 2 session should pick up next — always the highest priority `queued` row, not just whatever's oldest.

## Leads needing Solutions (queue)
This is the handoff point between MSD and Solution-building sessions. Live data lives in Supabase (`leads` table, `bucket`/`priority`/`status`/`solution_url`/`hours` columns) — this section is a portable snapshot for a fresh PxC session to read/update directly if Supabase access isn't already wired into that session. **Always sort by Priority, highest first — that's the order Phase 2 sessions work the queue in.**

| Priority | Lead (post link) | DS needed | Est. offer | Status | Solution link | Hours reported |
|---|---|---|---|---|---|---|
| [1-5, example row — delete once real data exists] | | | | queued | | |

Status values: `queued` → `building` (a PxC session is on it) → `built` (link + hours recorded, ready for Stage 5's *final* pricing pass, which re-checks the $20/hr floor against real hours).

## Solution-building sessions (separate PxC session, one lead at a time)
This is a distinct job from Phase 1 — a fresh session doing this reads this file, does the following, and stops:
1. Pick the next `queued` lead from the table above (or Supabase directly). Mark it `building`.
2. Build and deploy exactly one working DS. **No fixed tool or platform** — pick whatever free AI-builder actually fits this specific need. Known free options worth considering: Bolt.new (StackBlitz — full-stack, generous free token tier), v0 by Vercel (fast for landing pages/single-page tools), NxCode (full-stack from natural language, free tier includes deploy), Lovable (polished frontends, very limited free credits — pair with Supabase if data persistence is needed). None of these is mandatory; use whatever the lead actually calls for.
3. **Verify it before calling it done**: load the live URL yourself, confirm it actually works (200 OK, functions as intended) — do not write back a broken link.
4. Time/use-limit it per the demo requirement.
5. **Report hours**: the $20/hr pricing floor is based on Cj's own total active work time in *this session* — your processing time plus his prompting/iteration time. Self-log elapsed session time if feasible. If not feasible, **ask Cj directly for his total time on this lead** before Stage 5 runs — do not guess or omit this.
6. Write back to the queue (and Supabase if wired): `status: built`, `solution_url`, `hours`. Update Live status above. Stop — do not modify MSD/Worker code in this session.

## Stage 5 — Pricing ("Marie's Rule")
- **This is a lowball-and-underbid rule, not a fixed price.** There is no flat default number. Find the lowest number you can see or reasonably infer for this specific DS — a stated budget, a visible competing bid/quote, or (if genuinely nothing is stated) your best estimate of typical freelance market rate for this specific type/scope of build — then position the offer **below** that number. Never anchor to a generic figure unrelated to what this particular DS actually is.
- **Hard floor, non-negotiable**: the offer must clear **at least $20 for every hour reported in the queue for this lead** (Cj's own active session work time — see Solution-building step 5, not build-tool runtime). If the lowball number falls under that floor, raise the offer to the floor — go no lower.
- Between "as low as credible" and "the $20/hr floor," always take the lower number that still clears the floor.
- **Wording rule, always**: never say "price," "fee," or "ask." Use "offer" — e.g. *"I've built and deployed this Delivered Solution — here it is, live, at $/€X"* or *"I'm offering you this ready, fully-functional DS for $/€X."* It should read as already delivered and complete, just time/use-limited until claimed.

## Stage 6 — Drafting (voice-customizable, Gemini free tier)
Draft three things per lead:
1. **Warm-up/priming comments** — genuine, useful public comments on other relevant threads, to build MINDMERC's credibility/karma before outreach on a brand-new account. (See Account reality below — not optional.)
2. **A public reply on the target's own post** — first touch, lower-friction and less spam-flaggable than a cold DM out of nowhere. Often the better opener.
3. **The DM/offer copy itself** — includes the live Solution link from the queue and the Stage 5 offer amount, worded per the Stage 5 rule. Never mention how the DS was built, that AI or vibe-coding was involved, or any tool/process detail — the prospect sees a finished, professional, already-delivered product and nothing about its origin. Follow this structure exactly:
   > M·I·N·D·M·E·R·C — *Solver of Your Fortune*
   > Introducing MINDMERC: Search & Deploy — ending your problem before you finish describing it.
   > **S.A.M. — Solution Already Made:** [Name of Solution], live and testable now.
   > Commissioned for you. Full offer at $[XXX].
   > Dossier + working demo here: [link]

## Stage 7 — Approval loop (Telegram, mobile-native)
Every draft (priming comment, public reply, DM) goes to Telegram with inline **Approve / Reject / Redo**.
- Reject → discard.
- Redo → re-draft with feedback, re-present.
- Approve → see Stage 8.

## Stage 8 — Send (the ToS-compliant resolution — read this once, it's already solved)
Reddit's own policy prohibits apps from auto-sending DMs/comments without the recipient's consent, and prohibits automated bulk messaging. This isn't residue from an earlier plan — it's Reddit's current policy, and it still applies because Reddit is still the platform. The fix that keeps this "basically automated" while staying compliant and protecting the account:
**On Approve, the system returns the DM copy as a distinct, plain, easily copyable text block in Telegram — plus a tap-to-post/tap-to-send pre-filled link underneath.** Print the copyable text block regardless: Reddit's mobile app frequently strips URL parameters from deep links, so if the pre-filled link opens blank, Cj still has the exact text to paste by hand. Cj taps or pastes, then taps Send in Reddit's own UI. A real human fires every actual post/message — which is both what Reddit's policy requires and what keeps a 0-karma account from being algorithmically flagged as bot-operated. The bot never calls a send API directly.

## Account reality — pace this deliberately
Reddit doesn't publish exact numeric thresholds, but brand-new 0-karma accounts are heavily and automatically scrutinized, and unsolicited sales DMs to strangers is close to the exact pattern their spam detection is built to catch. **Do not front-load dozens of actions on day one.** Sequence: several genuine warm-up comments first (Stage 6, item 1) across a day or two, before the first outreach DM. Cap outbound DMs conservatively (a handful per day, not a burst) even after warm-up. Once MSD is deployed and running from Cloudflare's stable infrastructure, ongoing search/outreach isn't bouncing across rotating trial-sandbox IPs — that risk is specific to the Phase-1 build session, not ongoing operation.

## Stack (all free tier)
- Cloudflare Workers (Cron Trigger for the search/score/draft loop + a webhook route for Telegram button-presses) — no server to maintain
- Supabase (already have an account — check before duplicating) — tables: `leads` (bucket, status, solution_url, hours), `pitches`, `warmup_comments`
- Telegram bot via @BotFather — approval interface
- Gemini API key via AI Studio — scoring, extraction, and all drafting
- Reddit script-type app — client ID + secret provided by Cj at session start; OAuth password grant for search; no send-API usage per Stage 8

## What to do right now (Phase 1 session)
1. Get the Reddit client ID/secret from Cj directly — this is not your job to acquire.
2. Provision Cloudflare, Supabase, Telegram bot, Gemini API key.
3. Build and deploy the Worker implementing Stages 1–3 and 5–8, including the queue-write behavior for Bucket A leads and the 2-tap send pattern. Stage 4 does not exist as a Worker stage — Solution-building is a separate session (see above).
4. Confirm end-to-end up through the queue: search finds a post → extraction/triage runs → a Bucket-A lead lands correctly in the queue with status `queued`. Stop there — building a Solution is Phase 2's job, a different session.
5. Report back: what's live, what's blocked, any credentials to save (send directly, don't paste in plain chat). Update the Live status block above before ending the session.

## Explicitly out of scope for this agent
Bucket B leads (need Cj's PC/paid compute) — log and defer, don't attempt to build those now. Reddit app registration — Cj's job, not yours.
