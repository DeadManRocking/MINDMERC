/**
 * MINDMERC: Search & Deploy — Cloudflare Worker
 *
 * PASTE THIS ENTIRE FILE INTO CLOUDFLARE, AS-IS. Don't ask an AI to
 * rewrite or "improve" it during setup — just deploy it and set the
 * secrets below. Any real changes should come back through Claude.
 *
 * REQUIRED SECRETS (Cloudflare dashboard -> your Worker -> Settings -> Variables,
 * add each as an encrypted "Secret", not a plain variable):
 *   SUPABASE_URL           e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY   Supabase project -> Settings -> API -> service_role key
 *   GEMINI_API_KEY         from Google AI Studio
 *   GEMINI_MODEL           Gemini model name (a plain variable is fine — not a
 *                          secret). Default if unset: gemini-2.0-flash. Before
 *                          deploy, verify the model is still served on the free
 *                          tier: curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"
 *   TELEGRAM_BOT_TOKEN     from @BotFather
 *   TELEGRAM_CHAT_ID       your personal Telegram numeric chat id (see setup doc)
 *   TELEGRAM_SECRET        long random string (e.g. `openssl rand -hex 32`). MUST
 *                          match the secret_token passed to setWebhook — the
 *                          worker rejects any webhook POST that doesn't carry it.
 *
 * REQUIRED CLOUDFLARE SETUP:
 *   - Add a Cron Trigger: every 15 minutes (recommend switching to a 1-hour
 *     interval after the initial catch-up pass so daily Gemini free-tier usage
 *     stays under ~1,500 requests/day — see AUDIT.md section d).
 *   - After first deploy, set the Telegram webhook once:
 *       curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
 *         -d url="https://<worker-url>" \
 *         -d secret_token="<SAME random string as TELEGRAM_SECRET>" \
 *         -d allowed_updates='["callback_query"]'
 *     Verify with getWebhookInfo (pending_update_count 0, no last_error_message).
 *
 * SUPABASE SETUP: run supabase-schema.sql (rev 4) in the Supabase SQL editor first.
 * It is idempotent — safe to re-run on an existing rev-1/rev-2/rev-3 table.
 *
 * STAGE 1 (2026-08-17): multi-platform, all keyless. PRIMARY = Hacker News via
 * Algolia; BEST-EFFORT = Reddit via pullpush.io mirror (frequently challenges
 * datacenter IPs — degrades gracefully); SECONDARY = Stack Overflow (2 queries/tick
 * to stay under the ~300/day keyless budget). dev.to feed_content search is retired
 * (404) — see TODO in runIngest. Post ids are platform-prefixed (hn_/rp_/so_) so
 * cross-platform collisions are impossible; the unique post_id dedupe is unchanged.
 */

const SUBREDDITS = [
  "smallbusiness", "Entrepreneur", "forhire", "slavelabour",
  "webdev", "SaaS", "startups", "freelance"
];

const SEARCH_QUERY = "need OR help OR looking for OR urgent";

// ---- Stage 1 multi-platform sources (all keyless, free tier, no new secrets) ----
// Decision (owner, 2026-08-17): Reddit's unauthenticated search.json 403s datacenter
// egress IPs and the owner CANNOT create a Reddit app (registration blocked — no OAuth).
// Search now fans out across keyless public APIs; Reddit stays in via the pullpush.io
// public mirror (best-effort — it frequently Cloudflare-challenges datacenter IPs).

// PRIMARY — Hacker News via Algolia (keyless, datacenter-IP friendly).
const HN_QUERIES = [
  "need a developer",
  "looking for freelancer",
  "hire someone to build",
  "help with my website",
  "build an app for",
  "budget for a developer",
  "need help with my site"
];
const HN_DAYS_BACK = 30; // recency filter — a 2-year-old "need a developer" post is not a lead

// SECONDARY — Stack Overflow (keyless budget ~300 req/day → 2 queries/tick × 96 ticks = 192/day, leaves headroom).
const SO_QUERIES = [
  "need a developer",
  "hire someone to build"
];

// BEST-EFFORT — Reddit via pullpush.io mirror (free tier ~10 req/min → 2 grouped calls/tick).
const PULLPUSH_GROUPS = [
  ["smallbusiness", "Entrepreneur", "forhire", "slavelabour"],
  ["webdev", "SaaS", "startups", "freelance"]
];
const PULLPUSH_CALL_DELAY_MS = 4000; // pace the 2 pullpush calls per tick

const PLATFORM_FETCH_DELAY_MS = 1500; // small delay between platform fetches (shared rate-limit politeness)

// B5: free-tier Gemini pacing. Never exceed ~15 RPM and never analyze more than
// this many NEW posts per tick — a slow tick must not kill the run or burn the
// daily quota.
const MAX_ANALYSES_PER_TICK = 12;      // new posts analyzed per cron tick
const GEMINI_CALL_DELAY_MS = 4000;     // ~4s between sequential Gemini calls (15 RPM ceiling)

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runIngest(env));
    ctx.waitUntil(runPostBuild(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }
    return new Response("MINDMERC: Search & Deploy is running.");
  }
};

// ---------- STAGE 1-3: search, extract, triage, priority ----------

// ---------- STAGE 1-3: search, extract, triage, priority ----------

// Shared per-post pipeline for every platform (Stages 1 → 3). Returns "cap" when
// the per-tick analysis budget is exhausted (callers stop immediately, remaining
// work is deferred to the next cron tick) — otherwise a short status string.
async function ingestPost(env, state, post) {
  if (state.geminiCallsThisTick >= MAX_ANALYSES_PER_TICK) {
    console.error(`[ingest] per-tick analysis cap (${MAX_ANALYSES_PER_TICK}) reached — remaining posts deferred to next tick`);
    return "cap";
  }
  const exists = await supabaseGet(env, "leads", `post_id=eq.${post.post_id}`);
  if (exists && exists.length > 0) return "seen"; // already ingested (dedupe)

  // B5: pace sequential Gemini calls (~4s) to stay under the free-tier RPM.
  if (state.geminiCallsThisTick > 0) await sleep(GEMINI_CALL_DELAY_MS);
  state.geminiCallsThisTick++;

  const analysis = await analyzeLead(env, post);
  if (!analysis) return "no-analysis";
  if (analysis.bucket === "C") return "discarded-c"; // discard per Stage 3

  // B1: capture the post author now — needed later for the Stage 8
  // tap-to-send DM compose link. "[deleted]"/missing -> null (manual fallback).
  const author = post.author && post.author !== "[deleted]" ? post.author : null;

  // spec v3 (Stage 3 stated-budget gate): only bucket A rows are QUEUED —
  // buildable AND a stated purchase signal (stated budget / competing quote /
  // "hire now" language). W (buildable, no stated budget) and B (needs Cj's
  // PC/paid compute) are LOGGED with status 'deferred' — never queued, never
  // built. C was discarded above. priority is null for W/B (schema check is
  // 1-5; priority is only meaningful for A).
  // B8: on_conflict=post_id + resolution=ignore-duplicates makes this insert
  // tolerate a duplicate-key race (e.g. a transient dedupe-GET miss, or two
  // overlapping ticks) instead of erroring — no duplicate rows, no re-analysis
  // of an already-inserted post.
  await supabaseInsert(env, "leads", {
    post_id: post.post_id,
    post_url: post.post_url,
    post_title: post.post_title || "(untitled)",
    subreddit: post.subreddit,
    author,
    platform: post.platform, // rev 4: source platform (hackernews | reddit | stackoverflow)
    ds_needed: analysis.ds_needed,
    bucket: analysis.bucket,
    priority: analysis.priority,
    rough_offer_estimate: analysis.rough_offer_estimate,
    status: analysis.bucket === "A" ? "queued" : "deferred",
    drafted: false
  }, { onConflict: "post_id" });
  return "inserted";
}

async function runIngest(env) {
  const state = { geminiCallsThisTick: 0 };

  // 1. Hacker News via Algolia (PRIMARY — keyless, works from datacenter egress).
  await ingestHackerNews(env, state);
  await sleep(PLATFORM_FETCH_DELAY_MS);

  // 2. Reddit via pullpush.io mirror (BEST-EFFORT — see module header).
  await ingestRedditMirror(env, state);
  await sleep(PLATFORM_FETCH_DELAY_MS);

  // 3. Stack Overflow (SECONDARY — keyless budget is ~300 req/day, keep it low-volume).
  await ingestStackOverflow(env, state);

  // dev.to: /api/search/feed_content now 404s (endpoint retired by dev.to).
  // TODO (post-deploy): re-test https://dev.to/api/search/feed_content?q=...
  // if it ever returns again; leave OUT until then — not worth a broken fetch every tick.
}

// PRIMARY — Hacker News via Algolia search_by_date (newest first, 30-day window).
async function ingestHackerNews(env, state) {
  const since = Math.floor(Date.now() / 1000) - HN_DAYS_BACK * 86400;
  for (const q of HN_QUERIES) {
    if (state.geminiCallsThisTick >= MAX_ANALYSES_PER_TICK) return; // budget spent — defer rest to next tick
    try {
      const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=15&numericFilters=created_at_i%3E${since}`;
      let res;
      try {
        res = await fetch(url, { headers: { "User-Agent": "MINDMERC-SearchDeploy/1.0" } });
      } catch (e) {
        console.error(`[ingest] HN "${q}" fetch failed:`, e && e.message);
        await sleep(PLATFORM_FETCH_DELAY_MS);
        continue;
      }
      if (!res.ok) {
        console.error(`[ingest] HN "${q}" HTTP ${res.status} — skipping, retry next tick`);
        await sleep(PLATFORM_FETCH_DELAY_MS);
        continue;
      }
      // B7 pattern: guard res.json() — a non-JSON body must not kill the tick.
      let data;
      try {
        data = await res.json();
      } catch (e) {
        console.error(`[ingest] HN "${q}" non-JSON body (blocked/rate-limited?) — skipping`);
        await sleep(PLATFORM_FETCH_DELAY_MS);
        continue;
      }
      const hits = data?.hits || [];
      for (const hit of hits) {
        if (state.geminiCallsThisTick >= MAX_ANALYSES_PER_TICK) return;
        if (!hit || !hit.objectID) continue;
        const r = await ingestPost(env, state, {
          post_id: "hn_" + String(hit.objectID),
          post_url: hit.story_url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          post_title: hit.title || "(untitled)",
          selftext: hit.story_text || "",
          author: hit.author || null,
          subreddit: "hackernews",
          platform: "hackernews",
          created_utc: hit.created_at_i || null
        });
        if (r === "cap") return;
      }
    } catch (e) {
      console.error(`[ingest] HN "${q}" failed:`, e && e.message);
    }
    await sleep(PLATFORM_FETCH_DELAY_MS);
  }
}

// BEST-EFFORT — Reddit via the pullpush.io public mirror. Frequently Cloudflare-
// challenges datacenter IPs (HTML block page, same B7 failure shape as Reddit
// itself) — degrade gracefully, never crash the tick. 2 grouped calls/tick,
// paced ~4s apart to respect the ~10 req/min free tier.
async function ingestRedditMirror(env, state) {
  for (const group of PULLPUSH_GROUPS) {
    if (state.geminiCallsThisTick >= MAX_ANALYSES_PER_TICK) return;
    const subs = group.join(",");
    try {
      const url = `https://api.pullpush.io/reddit/search/submission/?subreddit=${subs}&q=${encodeURIComponent(SEARCH_QUERY)}&size=15&sort=desc&sort_type=created_utc`;
      let res;
      try {
        res = await fetch(url, { headers: { "User-Agent": "MINDMERC-SearchDeploy/1.0" } });
      } catch (e) {
        console.error(`[ingest] pullpush (${subs}) fetch failed:`, e && e.message);
        await sleep(PULLPUSH_CALL_DELAY_MS);
        continue;
      }
      if (!res.ok) {
        console.error(`[ingest] pullpush (${subs}) HTTP ${res.status} — skipping, retry next tick`);
        await sleep(PULLPUSH_CALL_DELAY_MS);
        continue;
      }
      let data;
      try {
        data = await res.json();
      } catch (e) {
        console.error(`[ingest] pullpush (${subs}) non-JSON body (Cloudflare challenge/block page?) — skipping`);
        await sleep(PULLPUSH_CALL_DELAY_MS);
        continue;
      }
      // pullpush returns {data: [ {...}, ... ]} (flat array) — unlike Reddit's
      // {data: {children: [...]}}. Accept both shapes defensively.
      let posts = data?.data || [];
      if (posts && posts.children && Array.isArray(posts.children)) {
        posts = posts.children.map((c) => c && c.data).filter(Boolean);
      }
      for (const post of posts) {
        if (state.geminiCallsThisTick >= MAX_ANALYSES_PER_TICK) return;
        if (!post || !post.id) continue;
        const sub = post.subreddit || "unknown";
        const r = await ingestPost(env, state, {
          post_id: "rp_" + String(post.id),
          post_url: post.permalink
            ? `https://www.reddit.com${post.permalink}`
            : `https://www.reddit.com/r/${sub}/comments/${post.id}`,
          post_title: post.title || "(untitled)",
          selftext: post.selftext || "",
          author: post.author || null,
          subreddit: sub,
          platform: "reddit",
          created_utc: post.created_utc || null
        });
        if (r === "cap") return;
      }
    } catch (e) {
      console.error(`[ingest] pullpush (${subs}) failed:`, e && e.message);
    }
    await sleep(PULLPUSH_CALL_DELAY_MS);
  }
}

// SECONDARY — Stack Overflow search/advanced (keyless ~300 req/day budget; 2
// queries × 96 ticks/day = 192 req/day, pagesize 5). Errors skip silently.
async function ingestStackOverflow(env, state) {
  for (const q of SO_QUERIES) {
    if (state.geminiCallsThisTick >= MAX_ANALYSES_PER_TICK) return;
    try {
      const url = `https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow&order=desc&sort=activity&q=${encodeURIComponent(q)}&pagesize=5`;
      let res;
      try {
        res = await fetch(url, { headers: { "User-Agent": "MINDMERC-SearchDeploy/1.0" } });
      } catch (e) {
        console.error(`[ingest] SO "${q}" fetch failed:`, e && e.message);
        await sleep(PLATFORM_FETCH_DELAY_MS);
        continue;
      }
      if (!res.ok) {
        console.error(`[ingest] SO "${q}" HTTP ${res.status} — skipping silently`);
        await sleep(PLATFORM_FETCH_DELAY_MS);
        continue;
      }
      let data;
      try {
        data = await res.json();
      } catch (e) {
        console.error(`[ingest] SO "${q}" non-JSON — skipping`);
        await sleep(PLATFORM_FETCH_DELAY_MS);
        continue;
      }
      if (data && data.error_message) {
        console.error(`[ingest] SO API error for "${q}": ${data.error_message} — skipping`);
        await sleep(PLATFORM_FETCH_DELAY_MS);
        continue;
      }
      const items = data?.items || [];
      for (const it of items) {
        if (state.geminiCallsThisTick >= MAX_ANALYSES_PER_TICK) return;
        if (!it || !it.question_id) continue;
        const r = await ingestPost(env, state, {
          post_id: "so_" + String(it.question_id),
          post_url: it.link || `https://stackoverflow.com/questions/${it.question_id}`,
          post_title: it.title || "(untitled)",
          selftext: "", // search/advanced doesn't return bodies; title-only triage
          author: (it.owner && it.owner.display_name) || null,
          subreddit: "stackoverflow",
          platform: "stackoverflow",
          created_utc: it.creation_date || null
        });
        if (r === "cap") return;
      }
    } catch (e) {
      console.error(`[ingest] SO "${q}" failed:`, e && e.message);
    }
    await sleep(PLATFORM_FETCH_DELAY_MS);
  }
}


async function analyzeLead(env, post) {
  // TODO (post-deploy): spec Stage 2 requires analyzing "each post + its comment
  // replies" — currently only title/selftext reach Gemini; add a Reddit comments
  // fetch (https://www.reddit.com{permalink}.json) and feed replies into the prompt.
  const prompt = `You are triaging a Reddit post for a business that builds quick software solutions.

POST TITLE: ${post.title}
POST BODY: ${post.selftext || "(no body text)"}

Return ONLY raw JSON, no markdown fences, matching this exact shape:
{
  "ds_needed": "one sentence describing the Delivered Solution that would meet this need",
  "urgency_evidence": "plainly_stated_with_number | plainly_stated_no_number | inferred_only | none",
  "bucket": "A | W | B | C",
  "priority": 1-5,
  "rough_offer_estimate": number
}

Rules:
- bucket A = buildable by a non-coder + AI in a single focused session (web app, script, automation, chatbot, small site, admin portal, etc.) AND the post/comments contain a STATED purchase signal: a stated budget, a competing quote, or explicit "hire now" language. ONLY A gets built.
- bucket W = buildable exactly like A, but NO stated purchase signal (no stated budget, no competing quote, no hire-now language) — log only, never build, never queue.
- bucket B = buildable but needs high-end local PC / paid heavy compute
- bucket C = not buildable this way at all (physical service, regulated software, etc.) — discard
- Be conservative: a false "buildable" call is worse than passing on a lead.
- rough_offer_estimate: find the lowest stated/implied budget or competing price in the post; if none, estimate typical freelance market rate for this specific task, then position below it. This is a rough pre-build estimate only.
- priority 1-5: combine urgency_evidence weight (stated-with-number > stated-no-number > inferred > none) with rough_offer_estimate value. 5 = most urgent + highest value. Priority is only meaningful for A; for W/B/C set 0.
- Treat inferred statements like "$X sounds reasonable" as urgency_evidence: inferred_only, not plainly_stated — and NOT a purchase signal, so they never qualify a lead for bucket A.
- If bucket is C, priority and rough_offer_estimate can be 0.`;

  const result = await callGemini(env, prompt);
  if (!result) return null;
  try {
    const cleaned = result.replace(/```json|```/g, "").trim();
    return normalizeAnalysis(JSON.parse(cleaned));
  } catch (e) {
    return null;
  }
}

// B10 (audit §i item 8): validate + normalize the model's analysis before anything
// is inserted. A lowercase "a" or a garbage bucket/priority must never land in the DB.
// spec v3: buckets are A (buildable + stated purchase signal -> queued), W (buildable
// but no stated budget -> logged, never built), B (needs Cj's PC/paid compute -> logged),
// C (discarded). Priority is only meaningful for A.
function normalizeAnalysis(a) {
  if (!a || typeof a !== "object") return null;
  const bucket = String(a.bucket || "").trim().toUpperCase();
  if (!["A", "W", "B", "C"].includes(bucket)) return null;

  const priority = Math.round(Number(a.priority));
  const estimate = (a.rough_offer_estimate === undefined || a.rough_offer_estimate === null)
    ? null : Number(a.rough_offer_estimate);

  if (bucket === "C") {
    // caller discards C rows; only the bucket needs to be valid here
    return { ds_needed: a.ds_needed ? String(a.ds_needed).trim() : null, bucket, priority, rough_offer_estimate: estimate };
  }

  // A/W/B rows go to the DB (A queued, W/B deferred-logged): ds_needed must be present.
  if (!a.ds_needed || !String(a.ds_needed).trim()) return null;
  const ds_needed = String(a.ds_needed).trim();

  if (bucket === "A") {
    // Only A is queued, so only A requires a valid 1-5 priority.
    if (!Number.isFinite(priority) || priority < 1 || priority > 5) return null;
    return {
      ds_needed,
      bucket,
      priority,
      rough_offer_estimate: Number.isFinite(estimate) && estimate >= 0 ? estimate : null
    };
  }

  // W/B: logged only — priority is meaningless here; store null (the schema's
  // check constraint only allows 1-5, and "0/ignored" is the spec rule for W/B/C).
  return {
    ds_needed,
    bucket,
    priority: null,
    rough_offer_estimate: Number.isFinite(estimate) && estimate >= 0 ? estimate : null
  };
}

// ---------- STAGE 5-6: final pricing + drafting, once a lead is marked 'built' ----------

async function runPostBuild(env) {
  const builtLeads = await supabaseGet(env, "leads", "status=eq.built&drafted=eq.false");
  if (!builtLeads || builtLeads.length === 0) return;

  for (const lead of builtLeads) {
    // B3: never price or draft a built lead without reported hours. Spec rule:
    // "ask Cj directly for his total time… do not guess or omit." A $0 offer is
    // never emitted. Cj gets exactly one notice per lead (hours_missing_notified).
    const hours = Number(lead.hours) || 0;
    if (hours <= 0) {
      if (!lead.hours_missing_notified) {
        await telegramSend(env, `Lead #${lead.id} is marked built but has no reported hours yet.\n\nSpec rule: do not guess or omit the total session time — ask Cj directly for his total active time on this lead before Stage 5 pricing runs. This lead will not be drafted or priced until hours are recorded.`, null);
        await supabaseUpdate(env, "leads", `id=eq.${lead.id}`, { hours_missing_notified: true });
      }
      continue;
    }

    // Idempotent retry (B4): if a previous tick stored drafts but a card send
    // failed partway, reuse the stored drafts — no Gemini re-spend, no re-price.
    let finalOffer = Number(lead.final_offer) || 0;
    let drafts = {
      warmup_comment: lead.warmup_comment,
      public_reply: lead.public_reply,
      dm_copy: lead.dm_copy
    };

    if (!finalOffer || !drafts.warmup_comment || !drafts.public_reply || !drafts.dm_copy) {
      const floor = hours * 20;
      finalOffer = Math.max(Number(lead.rough_offer_estimate) || 0, floor);

      const draftPrompt = `Write three pieces of copy for MINDMERC (a solutions business, tagline "Solver of Your Fortune").

CONTEXT:
Reddit post title: ${lead.post_title}
Need: ${lead.ds_needed}
Solution built and live at: ${lead.solution_url}
Offer amount: $${finalOffer}

Return ONLY raw JSON, no markdown fences:
{
  "warmup_comment": "a genuine, useful, unrelated-topic comment MINDMERC could post elsewhere to build account credibility",
  "public_reply": "a short, helpful, non-salesy first-touch reply to post directly on their thread, without revealing the offer yet",
  "dm_copy": "the full DM using this exact structure, with values filled in:\\nM·I·N·D·M·E·R·C — Solver of Your Fortune\\nIntroducing MINDMERC: Search & Deploy — ending your problem before you finish describing it.\\nS.A.M. — Solution Already Made: [Name of Solution], live and testable now.\\nCommissioned for you. Full offer at $[XXX].\\nDossier + working demo here: [link]"
}

Never mention AI, vibe-coding, or how the solution was built. It should read as already finished and delivered.
Wording rule (Stage 5): never say "price", "fee", or "ask" — always use "offer".`;

      const result = await callGemini(env, draftPrompt);
      if (!result) continue;
      let parsed;
      try {
        parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
      } catch (e) {
        continue;
      }
      drafts = {
        warmup_comment: parsed.warmup_comment,
        public_reply: parsed.public_reply,
        dm_copy: parsed.dm_copy
      };
      if (!drafts.warmup_comment || !drafts.public_reply || !drafts.dm_copy) continue;

      await supabaseUpdate(env, "leads", `id=eq.${lead.id}`, {
        final_offer: finalOffer,
        warmup_comment: drafts.warmup_comment,
        public_reply: drafts.public_reply,
        dm_copy: drafts.dm_copy,
        drafted: false // not yet — only set after the cards are actually sent (B4)
      });
    }

    // B4: mark drafted:true ONLY after all three approval cards sent successfully.
    // Any failure leaves drafted:false so the lead is retried next tick (with the
    // stored drafts above, so no re-draft/re-price).
    const okWarmup = await sendApprovalCard(env, lead.id, "warmup", drafts.warmup_comment, null);
    const okReply = await sendApprovalCard(env, lead.id, "reply", drafts.public_reply, lead.post_url);
    const okDm = await sendApprovalCard(env, lead.id, "dm", drafts.dm_copy, lead.post_url);

    if (okWarmup && okReply && okDm) {
      await supabaseUpdate(env, "leads", `id=eq.${lead.id}`, { drafted: true });
      console.error(`[post-build] lead #${lead.id}: all 3 approval cards sent, marked drafted`);
    } else {
      console.error(`[post-build] lead #${lead.id}: card send incomplete (warmup=${okWarmup} reply=${okReply} dm=${okDm}) — drafted stays false, will retry next tick`);
    }
  }
}

async function sendApprovalCard(env, leadId, type, text, postUrl) {
  const label = { warmup: "Warm-up comment", reply: "Public reply (primary path)", dm: "DM offer (fallback path)" }[type];
  const body = `${label} (lead #${leadId})\n\n${text}`;
  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `approve:${leadId}:${type}` },
      { text: "✏️ Redo", callback_data: `redo:${leadId}:${type}` },
      { text: "❌ Reject", callback_data: `reject:${leadId}:${type}` }
    ]]
  };
  return telegramSend(env, body, keyboard);
}

// ---------- STAGE 7-8: Telegram webhook, approval handling, send ----------

async function handleTelegramWebhook(request, env) {
  // B6: require the secret_token configured on the bot's webhook. The worker URL
  // is discoverable, so without this anyone could spoof approve/redo/reject.
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!secret || !env.TELEGRAM_SECRET || secret !== env.TELEGRAM_SECRET) {
    console.error("[webhook] rejected: missing/mismatched X-Telegram-Bot-Api-Secret-Token");
    return new Response("unauthorized", { status: 401 });
  }

  // B6: guard request.json() against non-JSON bodies — return ok, don't crash.
  let update;
  try {
    update = await request.json();
  } catch (e) {
    return new Response("ok");
  }

  const cb = update && update.callback_query;
  if (!cb) return new Response("ok");

  // B6: only the owner's Telegram account may drive approvals.
  if (!cb.from || String(cb.from.id) !== String(env.TELEGRAM_CHAT_ID)) {
    console.error("[webhook] rejected: callback from a non-owner user");
    return new Response("ok");
  }

  const [action, leadIdStr, type] = String(cb.data || "").split(":");
  const leadId = Number(leadIdStr);
  if (!leadId || !type) return new Response("ok");
  const field = { warmup: "warmup_comment", reply: "public_reply", dm: "dm_copy" }[type];
  if (!field) return new Response("ok");

  const rows = await supabaseGet(env, "leads", `id=eq.${leadId}`);
  const lead = rows && rows[0];
  if (!lead) return new Response("ok");

  if (action === "reject") {
    await telegramSend(env, `Rejected: ${type} for lead #${leadId}. Discarded.`, null);
  }

  if (action === "redo") {
    // TODO (post-deploy): spec Stage 7 "Redo → re-draft WITH feedback" — capture
    // the operator's actual feedback (callback_data field + input step) instead of
    // the generic "make it better/sharper" prompt below.
    if (!lead[field]) return new Response("ok");
    const redoPrompt = `Rewrite this ${type} for MINDMERC, make it better/sharper. Original:\n${lead[field]}\n\nReturn ONLY the rewritten text, no explanation, no markdown fences.`;
    const newText = await callGemini(env, redoPrompt);
    if (newText) {
      await supabaseUpdate(env, "leads", `id=eq.${leadId}`, { [field]: newText.trim() });
      await sendApprovalCard(env, leadId, type, newText.trim(), lead.post_url);
    }
  }

  if (action === "approve") {
    const copy = lead[field];
    if (!copy) {
      await telegramSend(env, `Nothing to send for ${type} on lead #${leadId} (copy is empty).`, null);
      return new Response("ok");
    }
    let tapLink = "";
    if (type === "reply") {
      // Stage 8 PRIMARY path — public comment on their thread. Tap-to-post link to
      // this specific post's comment box (the post permalink itself). A true
      // pre-filled reply is NOT reliably possible: Reddit's mobile app frequently
      // strips URL parameters, so the copyable block above is the reliable path.
      tapLink = `\n\nTap to open the thread and post this reply (public comment — PRIMARY path):\n${lead.post_url}\n\n(Reddit's mobile app frequently strips URL params, so the reply can't be pre-filled by link — tap the comment box and paste the copy above.)`;
    } else if (type === "dm") {
      // Stage 8 FALLBACK path — DM only. The bot NEVER calls a Reddit send API —
      // Cj taps this link (or copies the text) and sends it himself in Reddit's own UI.
      if (lead.author) {
        tapLink = `\n\nTap to open pre-filled compose (DM — fallback path; may not fill on the mobile app — text above is the reliable copy):\nhttps://www.reddit.com/message/compose/?to=${encodeURIComponent(lead.author)}&subject=Solution%20for%20your%20post&message=${encodeURIComponent(copy)}`;
      } else {
        tapLink = `\n\nNo stored author username for this lead — open Reddit, compose a message to the post's author manually, and paste the copy above.`;
      }
    }
    await telegramSend(env, `Approved — send this yourself now:\n\n${copy}${tapLink}`, null);
  }

  // Acknowledge the callback so Telegram stops showing a loading spinner on the button
  const ack = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cb.id })
  });
  if (!ack.ok) console.error(`[webhook] answerCallbackQuery HTTP ${ack.status}`);

  return new Response("ok");
}

// ---------- helpers: Supabase REST ----------

async function supabaseGet(env, table, filter) {
  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${filter}&select=*`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (e) {
    console.error(`[supabase] GET ${table} network error:`, e && e.message);
    return null;
  }
  if (!res.ok) {
    console.error(`[supabase] GET ${table} HTTP ${res.status}:`, await safeResponseText(res));
    return null;
  }
  return await res.json();
}

async function supabaseInsert(env, table, row, opts = {}) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}`;
  let prefer = "return=minimal";
  if (opts.onConflict) {
    url += `?on_conflict=${encodeURIComponent(opts.onConflict)}`;
    prefer = `resolution=${opts.resolution || "ignore-duplicates"},return=minimal`; // B8: tolerate duplicate post_id
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: prefer
      },
      body: JSON.stringify(row)
    });
  } catch (e) {
    console.error(`[supabase] INSERT ${table} network error:`, e && e.message);
    return false;
  }
  if (!res.ok) {
    console.error(`[supabase] INSERT ${table} HTTP ${res.status}:`, await safeResponseText(res));
    return false;
  }
  return true;
}

async function supabaseUpdate(env, table, filter, row) {
  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(row)
    });
  } catch (e) {
    console.error(`[supabase] UPDATE ${table} network error:`, e && e.message);
    return false;
  }
  if (!res.ok) {
    console.error(`[supabase] UPDATE ${table} HTTP ${res.status}:`, await safeResponseText(res));
    return false;
  }
  return true;
}

// ---------- helpers: Gemini ----------

async function callGemini(env, prompt, attempts = 0) {
  const model = env.GEMINI_MODEL || "gemini-2.0-flash"; // B5: model name is an env var
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }
  );

  // B5: exponential backoff on 429 (free-tier rate limit), capped — 5s -> 10s -> 20s.
  if (res.status === 429 && attempts < 3) {
    const backoffMs = Math.min(5000 * Math.pow(2, attempts), 20000);
    console.error(`[gemini] 429 rate-limited — retrying in ${backoffMs}ms (attempt ${attempts + 1}/3)`);
    await sleep(backoffMs);
    return callGemini(env, prompt, attempts + 1);
  }
  if (!res.ok) {
    console.error(`[gemini] HTTP ${res.status}:`, await safeResponseText(res));
    return null;
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

// ---------- helpers: Telegram ----------

async function telegramSend(env, text, replyMarkup) {
  const body = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text
    // B2: deliberately NO parse_mode. Plain text is the robust choice — AI-generated
    // copy contains Reddit/AI markdown (*, _, [, ], `) that would make Telegram's
    // "Markdown" parser reject the WHOLE message with a 400. The old code silently
    // swallowed that; now failures are logged and surfaced to the caller.
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error("[telegram] sendMessage network error:", e && e.message);
    return false;
  }
  if (!res.ok) {
    console.error(`[telegram] sendMessage HTTP ${res.status}:`, await safeResponseText(res));
    return false;
  }
  return true;
}

// ---------- helpers: misc ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeResponseText(res) {
  try { return await res.text(); } catch (e) { return ""; }
}
