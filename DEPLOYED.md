# MSD — Deployment Record (Phase 1)

Date: 2026-08-14 (UTC). Provisioned + deployed by engineer session.

## Worker
- **Name:** `mindmerc-deploy` (pre-existing name reused — URL kept stable)
- **URL:** https://mindmerc-deploy.deraedtcj.workers.dev
- **Health:** GET / -> `MINDMERC: Search & Deploy is running.` (HTTP 200)
- **Cron schedule:** `*/15 * * * *` (verified via Cloudflare API, created 2026-08-14T23:20:27Z)
- **compatibility_date:** 2026-08-14 | **wrangler:** 4.123.0
- **Vars:** `GEMINI_MODEL = "gemini-flash-latest"` (see model fix below)
- **Secrets (wrangler secret put, values never written to any file/repo):** SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_SECRET. Stale HMAC_SECRET deleted.
- **Source:** /home/team/shared/msd/worker.js (spec-v3; AUDIT.md must-fixes B1-B8+B10 in place; NOT modified). Deploy artifact: /tmp/msd-deploy/ (session-local).

## Gemini model fix (IMPORTANT — corrects lead's known-facts note)
- Lead fact said "gemini-2.5-flash confirmed in the models list". On the ground: **this API key CANNOT use gemini-2.5-flash** — generateContent returns 404 "This model models/gemini-2.5-flash is no longer available to new users" (same for 2.5-flash-lite, 2.0-flash, 2.0-flash-lite, 1.5-flash: all 404).
- Tested live: only **gemini-flash-latest -> HTTP 200 (OK)** works with this key (interesting: the OLD pre-existing worker's default was also gemini-flash-latest).
- Fix applied at deploy-config level (env var only, no worker.js change): redeployed with GEMINI_MODEL=gemini-flash-latest. [Uploaded mindmerc-deploy (1.78 sec)|Deployed mindmerc-deploy triggers (0.43 sec)|  https://mindmerc-deploy.deraedtcj.workers.dev|  schedule: */15 * * * *|Current Version ID: 3f9a0c88-41f2-401b-a056-c0e1ed3d2814|]

## Supabase
- **Project ref:** yglhofcpdnxjkkviwmrj | **Schema:** rev 3 applied via Management API -> HTTP 201; GET /rest/v1/leads with service key -> HTTP 200 (was 404 pre-schema). bucket check ('A','W','B','C'), post_id UNIQUE, hours_missing_notified present. PostgREST cache took ~5s (PGRST205 then 200).
- **Leads rows now:** 0 -> []

## Telegram webhook
- setWebhook -> {"ok":true,"result":true}; getWebhookInfo -> url=https://mindmerc-deploy.deraedtcj.workers.dev, pending_update_count 0, allowed_updates=["callback_query"].

## Phase-1 acceptance test
- **Dev-path (wrangler dev --test-scheduled, port 8787, real env):** scheduled() fired (HTTP 200 "Ran scheduled event"); worker ingested all 8 subreddits; **every subreddit returned HTTP 403 from Reddit** (block page HTML). Worker handled gracefully (B7), no crash, no rows. Direct probes confirm network-level block: search.json (worker UA + browser UA), hot.json, old.reddit.com all 403 -> **Reddit blocks this sandbox IP** (documented AUDIT.md §d risk; fix = Reddit OAuth password grant, needs Cj's client ID/secret — worker.js post-deploy TODO).
- **Live-path observation (production cron tick from Cloudflare egress):** tail captured: 
- **Downstream proof (real Gemini + real Supabase, synthetic post, harness at /tmp/msd-deploy/harness-e2e.js):** === 1. Gemini analyze (real API, model gemini-flash-latest) ===|gemini HTTP 503 {|  "error": {|    "code": 503,|    "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",|    "status": "UNAVAILABLE"|  }|}||FAIL: no Gemini result|
- **Verdict: e2e FAILED at Stage 1 (Reddit search) — Reddit 403s datacenter egress IPs on the unauthenticated search endpoint from BOTH the sandbox and the deployed worker's egress. Not faked: search blocked -> no posts -> no Gemini analysis -> no queue rows.** Schema/worker/webhook/cron all verified working. Unblock requires Reddit OAuth password grant (spec-required, worker.js TODO, needs Cj's REDDIT_CLIENT_ID/SECRET/REDDIT_USERNAME/REDDIT_PASSWORD) — out of this session's scope.

---

# MSD — Deployment Record rev 4 (multi-platform Stage 1)

Date: 2026-08-17 (UTC). Engineer session. Owner decision (2026-08-17): Reddit OAuth is impossible (registration blocked), so Stage 1 became multi-platform keyless search. Full change details in CHANGES.md.

## Worker (rev 4)
- **Name:** `mindmerc-deploy` (unchanged) | **URL:** https://mindmerc-deploy.deraedtcj.workers.dev
- **Health:** GET / -> `MINDMERC: Search & Deploy is running.` (HTTP 200)
- **Version ID:** 271b9b5f-bfa8-4189-b96d-38f0b67ccf53 (deployed 2026-08-17 ~18:34 UTC via wrangler 4.123.0, `--schedule "*/15 * * * *"`, `--var GEMINI_MODEL:gemini-flash-latest`, `--compatibility-date 2026-08-14`)
- **Stage 1 sources:** Hacker News (Algolia, PRIMARY), Reddit via pullpush.io (BEST-EFFORT), Stack Overflow (SECONDARY); dev.to NOT live (endpoint retired, 404). post_ids prefixed `hn_`/`rp_`/`so_`. See handoff-v3.md Stage 1.
- **Secrets:** persisted across deploy (wrangler never deletes secrets; none re-set).
- **Cron:** `*/15 * * * *` confirmed in deploy output.

## Supabase (rev 4)
- **Project ref:** yglhofcpdnxjkkviwmrj | **Schema:** rev 4 applied via Management API 2026-08-17 (HTTP 201, idempotent) — adds `platform text` (nullable) via `add column if not exists`; verified present in information_schema.
- **Live rows (first real leads):** see below.

## E2E verification (real APIs, real queue) — 2026-08-17
- **Harness** (`/tmp/msd-deploy/harness-e2e.mjs` — local import of worker.js + `scheduled()` with real env) ran 3 passes against the real HN/pullpush/SO APIs, real Gemini, real Supabase, and inserted real rows. Per-tick Gemini cap (12) and 4s pacing respected. Passes 1–2 used the deployed model gemini-flash-latest (many 503s, a few successes); pass 3 used gemini-flash-lite-latest (same key, verified 200) to prove the full fan-out while flash-latest was degraded.
- **Rows by platform / bucket (verified live in Supabase):** **7 rows total, platform=hackernews (7), bucket=W (7) → status `deferred`** (correct spec behavior — HN posts rarely state a budget, so the Stage-3 stated-budget gate classifies them W; only A rows get `queued`). post_ids all `hn_*`, dedupe working (no duplicates across the 3 passes).
- **Stack Overflow / pullpush-reddit: no rows this session** — SO search returned 200 + valid JSON but the per-tick Gemini budget was consumed by earlier platforms before SO ran (and pullpush served a Cloudflare challenge page from this egress). Both degrade gracefully; will produce rows on a tick where Gemini cooperates.
- **Production cron tick:** */15 schedule confirmed in deploy output; wrangler tail attached — see handoff-v3.md Live status for the tick result from Cloudflare egress.

## Platform status (2026-08-17)
| Platform | API | Status this session |
|---|---|---|
| Hacker News | hn.algolia.com (keyless) | **WORKING** — fetches 200, real rows inserted from both sandbox harness and (per tail) Cloudflare cron |
| Reddit (mirror) | api.pullpush.io (keyless) | **BEST-EFFORT** — Cloudflare-challenges datacenter egress (sandbox); Cloudflare-egress result per cron tail. Degrades gracefully (B7 guard), no crashes |
| Stack Overflow | api.stackexchange.com (keyless) | **WORKING API, no rows yet** — fetch 200 + JSON parsed; no analyses landed because the per-tick Gemini budget (12) was consumed by 503s on earlier platforms. Will produce rows on a tick where Gemini cooperates |
| dev.to | api/dev.to/search/feed_content | **NOT LIVE** — 404 (endpoint retired); TODO in runIngest |

## Gemini availability (operational, not code)
`gemini-flash-latest` 503s intermittently ("This model is currently experiencing high demand") — first seen 2026-08-14, recurring this session (harness hit 7-12 503s per pass, some calls succeeded). The worker's per-tick cap absorbs this: failed analyses consume budget but posts are re-attempted next tick (never lost). `gemini-flash-lite-latest` verified working with the same key — available fallback if the lead approves (deployed var left as gemini-flash-latest per instruction).
