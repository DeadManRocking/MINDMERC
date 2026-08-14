# MINDMERC: Search & Deploy
MINDMERC is a Cloudflare Worker that searches Reddit for people publicly asking for IT/AI help (coding, agents, app builds, sites, portals, dashboards), extracts the need and urgency from each post, triages every lead into exactly one bucket, prices each job per the spec's underbid rule (position the offer below the lowest visible or inferable number), drafts warm, truthful outreach copy via Gemini, and routes it through a Telegram approval loop with a human-only two-tap send — the bot never calls Reddit's send APIs. The worker runs on a Cloudflare cron trigger, so it operates on its own once deployed.

## Triage buckets (spec v3 — Stage 3 stated-budget gate)
- **A — Buildable now AND stated purchase signal** (a stated budget, a competing quote, or explicit "hire now" language in the post/comments): queued with a 1–5 priority. These are the only leads Phase 2 sessions build. The gate exists because build cost is paid on every lead but revenue only on conversions.
- **W — Watch: buildable but no stated budget**: logged separately with status `deferred`, never built, never queued.
- **B — Buildable, but needs Cj's high-end PC / paid compute**: logged with status `deferred`, reported to Cj, not queued.
- **C — Not buildable in this model**: discarded at ingest.

## Send paths (spec v3 — Stage 8)
**Public comment on the prospect's thread is the PRIMARY path** (contextual, publicly verifiable, builds karma, one build can attract multiple buyers). On Approve, the worker returns a tap-to-post link to that post's comment box plus a copyable text block — Reddit's mobile app frequently strips URL params, so a true pre-filled reply isn't reliably possible and the copy block is the reliable path. **DM is the fallback** (copyable text block + pre-filled compose link using the stored author username). Either way a real human taps Send in Reddit's own UI; the bot never calls a Reddit send API.

## Lifecycle — two phases
1. **Phase 1 (once):** Build and deploy MSD itself — this worker, the Supabase schema, the Telegram bot, and the Gemini wiring. Once deployed, the worker runs on its own on Cloudflare's cron; no ongoing session is needed to keep it running.
2. **Phase 2 (repeated, per lead):** The worker finds and triages leads on its own and queues the highest-priority Bucket-A ones. Separately, whenever there is a queued lead, a fresh session builds exactly one solution for exactly one queued lead, writes the result back to the queue, and stops — it does not touch MSD's code. The `leads` table's `priority`/`status` columns are the handoff point between the two phases.

## Repository contents
| File | Purpose |
|---|---|
| `worker.js` | The Cloudflare Worker (search → extract → triage → price → draft → Telegram approval loop) |
| `supabase-schema.sql` | Supabase schema (rev 3, idempotent) — run in the Supabase SQL editor before first deploy |
| `AUDIT.md` | Audit report of worker.js vs. handoff-v3.md, including the deployment checklist |
| `CHANGES.md` | Changelog of fixes applied since the audit |
| `handoff-v3.md` | Business/spec document describing the full pipeline and operating rules |

## Deploy
Follow the deployment checklist in [AUDIT.md §h](AUDIT.md) ("DEPLOYMENT CHECKLIST"), and set the required secrets listed in the [worker.js header](worker.js) (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_SECRET`). Run `supabase-schema.sql` in Supabase first, add the cron trigger, deploy the worker as-is, then set the Telegram webhook with a matching `secret_token`.
