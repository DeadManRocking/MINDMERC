-- ============================================================
-- MINDMERC: Search & Deploy — Supabase schema (rev 3)
-- Run in Supabase SQL editor (Dashboard -> SQL -> New query) BEFORE
-- the first Worker deploy. Idempotent: safe to re-run, and the
-- ALTERs below upgrade an existing rev-1/rev-2 table in place.
-- ============================================================

create table if not exists public.leads (
  id                    bigint generated always as identity primary key,
  post_id               text not null unique,          -- Reddit fullname, e.g. 't3_1abc2d' (worker writes post.name)
  post_url              text not null,                 -- https://www.reddit.com + post.permalink
  post_title            text not null,
  subreddit             text not null,
  author                text,                          -- target Reddit username (worker stores post.author; NULL if deleted/missing) — used for the Stage 8 tap-to-send compose link (DM fallback path)
  ds_needed             text,                          -- implied Delivered Solution (Gemini)
  bucket                text not null check (bucket in ('A','W','B','C')),
  priority              smallint check (priority between 1 and 5),  -- meaningful for A only; W/B/C rows store NULL
  rough_offer_estimate  numeric(10,2),                 -- Stage 3 pre-build estimate
  status                text not null default 'queued' check (status in ('queued','building','built','deferred')),
  drafted               boolean not null default false,
  hours                 numeric(6,2),                  -- reported by Phase 2 solution-building session
  solution_url          text,                          -- live demo link, written back by Phase 2 session
  final_offer           numeric(10,2),                 -- Stage 5 final pricing pass (Marie's Rule, $20/hr floor)
  warmup_comment        text,
  public_reply          text,
  dm_copy               text,
  hours_missing_notified boolean not null default false, -- B3: set true once Cj has been told a built lead is missing hours (prevents a repeat Telegram notice every tick)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- rev-1 -> rev-2 upgrade for tables created before this column existed.
-- create table if not exists does NOT add columns to an existing table,
-- so an idempotent ALTER is needed for deployments that already ran rev 1.
alter table public.leads add column if not exists hours_missing_notified boolean not null default false;

-- rev-2 -> rev-3 upgrade (spec v3, Stage 3 stated-budget gate): a new Watch bucket
-- 'W' (buildable but no stated budget — logged, never queued/built). The old inline
-- check only allowed ('A','B','C'); drop it if present and re-add with 'W'. Safe to
-- re-run: a fresh table's inline check above auto-names the same constraint
-- (leads_bucket_check), so drop + re-add is an in-place no-op upgrade either way.
alter table public.leads drop constraint if exists leads_bucket_check;
alter table public.leads add constraint leads_bucket_check check (bucket in ('A','W','B','C'));

-- Bucket semantics (spec v3): A = buildable + stated purchase signal -> status
-- 'queued'; W = buildable, no stated budget -> 'deferred' (logged, never built);
-- B = needs Cj's PC/paid compute -> 'deferred' (logged, reported to Cj); C = not
-- buildable -> discarded at ingest (no row). Phase 2 only ever picks status='queued'.

-- Queue queries: runPostBuild pulls status=built & drafted=false;
-- Phase 2 sessions pick highest priority queued row.
create index if not exists leads_status_drafted_idx on public.leads (status, drafted);
create index if not exists leads_bucket_priority_idx  on public.leads (bucket, priority desc);

-- Keep updated_at fresh on any UPDATE (worker never sets it explicitly).
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

-- RLS on with NO policies: the worker authenticates with the service_role /
-- dedicated app key, which bypasses RLS. Enabling RLS with zero policies
-- blocks accidental reads/writes via the anonymous key if it ever leaks.
alter table public.leads enable row level security;

-- ============================================================
-- Notes / future hardening (not required for first deploy):
--  * Consider a least-privilege app role instead of service_role:
--      create role msd_app noinherit login password '<strong>';
--      grant usage on schema public to msd_app;
--      grant select, insert, update on public.leads to msd_app;
--    then set SUPABASE_SERVICE_KEY to msd_app's password and
--    SUPABASE_URL to https://<project>.supabase.co (same REST API).
--  * post_id is UNIQUE (dedupe safety net, B8). The worker now inserts with
--    Prefer: resolution=ignore-duplicates + on_conflict=post_id, so duplicate
--    keys are tolerated (no-op) instead of erroring — no dup rows, no
--    double Gemini spend on a post that was already inserted.
-- ============================================================
