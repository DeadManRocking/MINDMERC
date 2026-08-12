# MINDMERC: Search & Deploy

MINDMERC is a Cloudflare Worker that searches Reddit for people publicly asking for IT/AI help (coding, agents, app builds, sites, portals, dashboards), extracts the need and urgency from each post, triages the promising leads into a Supabase queue with a priority score, prices each job per the spec's underbid rule (position the offer below the lowest visible or inferable number), drafts warm, truthful outreach copy via Gemini, and routes it through a Telegram approval loop with a human-only two-tap send — the bot never calls Reddit's send APIs. The worker runs on a Cloudflare cron trigger, so it operates on its own once deployed.

## Lifecycle — two phases

1. **Phase 1 (once):** Build and deploy MSD itself — this worker, the Supabase schema, the Telegram bot, and the Gemini wiring. Once deployed, the worker runs on its own on Cloudflare's cron; no ongoing session is needed to keep it running.
2. **Phase 2 (repeated, per lead):** The worker finds and triages leads on its own and queues the highest-priority ones. Separately, whenever there is a queued lead, a fresh session builds exactly one solution for exactly one queued lead, writes the result back to the queue, and stops — it does not touch MSD's code. The `leads` table's `priority`/`status` columns are the handoff point between the two phases.

## Repository contents

| File | Purpose |
|---|---|
| `worker.js` | The Cloudflare Worker (search → extract → triage → price → draft → Telegram approval loop) |
| `supabase-schema.sql` | Supabase schema (rev 2, idempotent) — run in the Supabase SQL editor before first deploy |
| `AUDIT.md` | Audit report of worker.js vs. handoff-v3.md, including the deployment checklist |
| `CHANGES.md` | Changelog of fixes applied since the audit |
| `handoff-v3.md` | Business/spec document describing the full pipeline and operating rules |

## Deploy

Follow the deployment checklist in [AUDIT.md §h](AUDIT.md) ("DEPLOYMENT CHECKLIST"), and set the required secrets listed in the [worker.js header](worker.js) (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_SECRET`). Run `supabase-schema.sql` in Supabase first, add the cron trigger, deploy the worker as-is, then set the Telegram webhook with a matching `secret_token`.
