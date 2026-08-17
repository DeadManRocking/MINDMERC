# CHANGES — worker.js must-fix implementation (rev 2)

Date: 2026-08-11 | Engineer session | Implements every must-fix item in AUDIT.md §i (bugs B1–B8, plus B10 shape validation which §i item 8 covers). No deployment, no external calls — verified locally with `node --check` only.

- **B1** — `post.author` now captured at ingest and stored in the new `author` column; DM approve branch composes the tap-to-send link with the real username (`encodeURIComponent(lead.author)`), and shows a clear manual-compose instruction when author is missing/`[deleted]` instead of a placeholder. (worker.js: runIngest insert block, handleTelegramWebhook approve branch)
- **B2** — `parse_mode: "Markdown"` removed entirely; all Telegram sends are plain text (no parser to break). `telegramSend` now checks `res.ok`, logs the failure, and returns a bool; `sendApprovalCard` returns it. (worker.js: telegramSend, sendApprovalCard)
- **B4** — `drafted: true` is now written ONLY after all three approval cards send OK; on any failure `drafted` stays false and the lead is retried next tick. Retry reuses the stored drafts (skips Gemini re-draft/re-price). (worker.js: runPostBuild)
- **B3** — `runPostBuild` skips any `built` lead with `hours <= 0` (never prices, never drafts, never emits a $0 offer); sends Cj exactly one Telegram notice (new `hours_missing_notified` flag prevents repeat spam every tick) that the lead needs hours before pricing. (worker.js: runPostBuild; schema rev 2 adds the column)
- **B5** — per-tick cap `MAX_ANALYSES_PER_TICK = 12` on NEW-post Gemini analyses, ~4s inter-call delay (`GEMINI_CALL_DELAY_MS = 4000`), exponential 429 backoff in `callGemini` (5s→10s→20s, capped, max 3 attempts), and model name moved to env var `GEMINI_MODEL` (default `gemini-2.0-flash`, verify at deploy). A slow tick now can't kill the run or burn the daily quota. (worker.js: runIngest loop, callGemini)
- **B6** — webhook requires matching `X-Telegram-Bot-Api-Secret-Token` header vs env `TELEGRAM_SECRET` (401 otherwise); non-owner callback_query (`cb.from.id` !== `TELEGRAM_CHAT_ID`) is ignored; `request.json()` is guarded against non-JSON bodies (returns 200 "ok"). (worker.js: handleTelegramWebhook)
- **B7** — `res.json()` after the Reddit fetch is try/caught (200-with-HTML block pages skip the subreddit instead of killing the tick); the whole per-subreddit body is wrapped so one bad subreddit never aborts the rest. (worker.js: runIngest)
- **B8** — ingest insert now uses PostgREST upsert `on_conflict=post_id` + `Prefer: resolution=ignore-duplicates`, so a duplicate-key race (transient dedupe-GET miss, overlapping ticks) is a no-op instead of an error — no duplicate rows, no re-analysis of an already-inserted post. The schema already had `post_id unique` (schema file unchanged for this). (worker.js: supabaseInsert, runIngest call site)
- **B10** (part of §i item 8) — analysis output validated/normalized before insert: bucket uppercased and checked A/B/C, priority must be 1–5 (A/B), ds_needed required; garbage model output is rejected, not inserted. (worker.js: normalizeAnalysis)
- **B11** (bonus, cheap) — supabaseGet/supabaseInsert/supabaseUpdate now check `res.ok` and log failures instead of fire-and-forget; `safeResponseText` helper added.
- Header — REQUIRED SECRETS updated with `GEMINI_MODEL` and `TELEGRAM_SECRET`; Cron Trigger + setWebhook-with-secret_token instructions added (hourly cron recommended after catch-up per AUDIT.md §d).

Deliberately deferred (audit §i can-wait; NOT in this scope, `// TODO (post-deploy):` comments left at the sites):
- Reddit OAuth password grant for search (§i #10) — TODO in runIngest next to the search fetch.
- Stage 2 comment fetching (§i #9) — TODO in analyzeLead.
- Redo-with-feedback (§i #11) — TODO in webhook redo branch.
- Per-day Gemini budget counter (KV-based, §i #5 tail) — hourly cron noted in header as the deploy-time mitigation.
- Added anyway (trivially safe, spec-aligned): Stage 5 wording rule ("never say price/fee/ask — use offer") is now one line in the draft prompt.

Schema: supabase-schema.sql bumped rev 1 → rev 2 — adds `hours_missing_notified` (needed by B3's one-time notice) with an idempotent `alter table ... add column if not exists` so an existing rev-1 table upgrades in place. `post_id unique` for B8 was already present — no other schema change.

---

# CHANGES — spec v3 (Stage 3 stated-budget gate + Watch bucket; Stage 8 public-comment-primary)

Date: 2026-08-14 | Engineer session | Implements the two material spec changes in handoff-v3.md (dated 2026-08-14). No deploy, no external calls — verified locally with `node --check` + secrets scan only.

- **Stage 3 — stated-budget gate + new Watch bucket.** Bucket A now requires a STATED purchase signal: a stated budget, a competing quote, or explicit "hire now" language in the post/comments. A buildable lead WITHOUT that signal is no longer A — it is a new **Watch** bucket: logged separately, never built, never queued. B (needs Cj's PC/paid compute) and C (not buildable) unchanged. Gate exists because build cost is paid on every lead but revenue only on conversions.
  - `analyzeLead` Gemini prompt rules updated: A = buildable AND stated purchase signal; W = buildable but no stated budget (log only); B/C unchanged; explicit "be conservative" instruction; inferred statements like "$X sounds reasonable" flagged as NOT a purchase signal. (worker.js: analyzeLead prompt)
  - `normalizeAnalysis` now accepts buckets A/W/B/C (uppercase validation). A requires ds_needed + priority 1–5; W/B require ds_needed but store `priority: null` (spec: priority only meaningful for A, 0/ignored for W/B/C — NULL satisfies the schema's 1–5 check). C returns early as before. (worker.js: normalizeAnalysis)
  - Ingest: only bucket A rows get `status: 'queued'`; W/B rows are inserted with `status: 'deferred'` and their bucket stored as-is; C discarded (unchanged). The existing `bucket === "A" ? "queued" : "deferred"` ternary already routes W correctly. (worker.js: runIngest insert block)
- **Schema rev 2 → rev 3** — `bucket` check constraint now allows ('A','W','B','C') via an idempotent migration: `drop constraint if exists leads_bucket_check` + re-add including 'W' (safe to re-run; fresh tables get the updated inline check). Everything else in the schema untouched. (supabase-schema.sql)
- **Stage 8 — public comment is now the PRIMARY send path; DM is the fallback.**
  - Approve on the **public-reply** card now returns a tap-to-post link to that post's comment box (the post permalink/URL) and explicitly notes Reddit's mobile app frequently strips URL params, so a true pre-filled reply isn't reliably possible — the copyable text block (printed first, unchanged) is the reliable path. (worker.js: handleTelegramWebhook approve branch)
  - Approve on the **DM** card is unchanged (copyable text block first + pre-filled compose link using the stored author username) and is now explicitly labelled the fallback path. (worker.js: approve branch, sendApprovalCard label "DM offer (fallback path)")
  - Approval card labels now say "Public reply (primary path)" / "DM offer (fallback path)". The bot still never calls a Reddit send API — a real human always fires the post/message in Reddit's own UI.
- **README.md** — pipeline description updated: triage buckets A/W/B/C (A queued, W/B logged-deferred, C discarded) and Stage 8 "public comment primary, DM fallback" wording; schema row bumped to rev 3.
- **handoff-v3.md** — replaced with the 2026-08-14 spec revision (already the live spec in /home/team/shared/msd).

Deferred (unchanged from rev 2, TODO comments still in place): Reddit OAuth password grant for search, Stage 2 comment fetching, redo-with-feedback.

---

# CHANGES — multi-platform Stage 1 search (rev 4)

Date: 2026-08-17 | Engineer session | Owner decision: Reddit unauthenticated search.json 403s datacenter egress IPs (verified sandbox + Cloudflare egress) and the owner CANNOT create a Reddit app (registration blocked, no OAuth). Stage 1 now fans out across keyless public APIs. Deployed + rev-4 schema applied + E2E verified live (real rows in Supabase from Hacker News).

- **Stage 1 rewrite (worker.js runIngest) — three platform fetchers + one shared per-post pipeline:**
  - `ingestHackerNews` (PRIMARY) — Algolia `search_by_date`, 7 buyer-intent queries, `tags=story`, 15 hits/query, 30-day recency filter (`numericFilters=created_at_i>...`; a stale "need a developer" post is not a lead). Normalized: `post_id = "hn_"+objectID`, `post_url = story_url || item URL`, `selftext = story_text`, `subreddit = "hackernews"`, `platform = "hackernews"`.
  - `ingestRedditMirror` (BEST-EFFORT) — pullpush.io submission search over the same 8 subreddits in 2 paced groups (~4s apart; free tier ~10 req/min). Accepts both `{data:[...]}` (pullpush) and `{data:{children:[...]}}` (Reddit) shapes. `post_id = "rp_"+id`, `post_url = https://www.reddit.com + permalink`, `platform = "reddit"`. Cloudflare challenge pages (HTML) degrade gracefully — same B7 pattern as the old Reddit fetch.
  - `ingestStackOverflow` (SECONDARY) — StackExchange search/advanced, 2 queries/tick × pagesize 5 (keyless budget ~300 req/day → ~192/day, leaves headroom). Errors skip silently. `post_id = "so_"+question_id`, `post_url = link`, `platform = "stackoverflow"`.
  - `ingestPost` — the old per-subreddit loop body (dedupe GET → Gemini analysis → normalize → upsert) extracted verbatim into a shared function used by all three fetchers; only the insert now also writes `platform`. Stages 2–8 untouched (analyzeLead, normalizeAnalysis, runPostBuild, webhook, helpers all unchanged).
  - dev.to `/api/search/feed_content` now 404s (endpoint retired) — left as `// TODO (post-deploy):` in runIngest, not implemented.
- **Schema rev 3 → rev 4 (supabase-schema.sql)** — adds `platform text` (nullable) via idempotent `alter table public.leads add column if not exists platform text;` + included in the create-table block. NULL for any pre-rev-4 rows; no check/other changes.
- **Post-id namespacing** — `hn_`/`rp_`/`so_` prefixes make cross-platform collisions impossible; the unique `post_id` + upsert dedupe (B8) is unchanged.
- **Constants** — `HN_QUERIES` (7 phrases), `SO_QUERIES` (2), `PULLPUSH_GROUPS` (2×4 subs), `HN_DAYS_BACK = 30`, `PLATFORM_FETCH_DELAY_MS = 1500`, `PULLPUSH_CALL_DELAY_MS = 4000`. Per-tick Gemini cap (12) and 4s inter-call delay unchanged — the Gemini budget is shared and untouched.

Deployed: worker mindmerc-deploy (version 271b9b5f-bfa8-4189-b96d-38f0b67ccf53), cron `*/15 * * * *`, GEMINI_MODEL=gemini-flash-latest unchanged. Rev-4 schema applied via Management API (HTTP 201, idempotent). E2E verified (details in DEPLOYED.md).

Operational note (not a code change): gemini-flash-latest has been intermittently 503ing ("high demand") on this key since before this session (first seen in the 2026-08-14 deploy record). During a 503 window the per-tick analysis budget is consumed by failed calls and no rows insert that tick; posts are re-attempted next tick (never permanently lost). gemini-flash-lite-latest was verified working with the same key and is available as a fallback if the lead ever wants it — the deployed var was NOT changed per instruction.
