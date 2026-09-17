-- Run this in the Supabase SQL editor.
-- Put it in the project that already hosts househunt rather than creating a
-- second one: the free tier allows two active projects, and a project with no
-- database activity for seven days gets paused. Sharing the existing project
-- keeps a slot free and means the pick'em tables can't go to sleep in February
-- when you turn the cron off for the offseason.

create table if not exists pickem_snapshots (
  id            bigint generated always as identity primary key,
  snapshot_date date        not null,
  matchup       text        not null,          -- 'BUF@HOU', teams sorted
  kickoff       timestamptz,
  pick          text        not null,          -- canonical team abbreviation
  confidence    numeric(5,3) not null,         -- blended probability of `pick`
  probabilities jsonb       not null,          -- {"BUF":0.62,"HOU":0.38}
  kalshi        jsonb,                         -- null if game absent from Kalshi
  polymarket    jsonb,                         -- null if game absent from Polymarket
  venue_spread  numeric(5,3),                  -- |kalshi - polymarket| on team 1
  sources       text[]      not null default '{}',
  created_at    timestamptz not null default now(),

  -- One row per game per day. Re-running the job the same day overwrites
  -- rather than duplicating.
  unique (snapshot_date, matchup)
);

create index if not exists pickem_snapshots_kickoff_idx
  on pickem_snapshots (kickoff);

-- Health table. A failed Vercel cron invocation produces no retry, no email,
-- and no dashboard warning, so this is how you notice it stopped running.
create table if not exists pickem_runs (
  snapshot_date date primary key,
  ran_at        timestamptz not null,
  games         int         not null default 0,
  tiebreaker    jsonb,                          -- {matchup, expected_total, ...}
  duration_ms   int,
  ok            boolean     not null default true,
  error         text
);

-- Latest picks for the upcoming slate, for the read-only page.
create or replace view pickem_current as
select distinct on (matchup)
  matchup, kickoff, pick, confidence, probabilities,
  kalshi, polymarket, venue_spread, sources, snapshot_date
from pickem_snapshots
where kickoff is null or kickoff > now() - interval '6 hours'
order by matchup, snapshot_date desc;

-- Line movement through the week: the same game across daily snapshots.
-- Injury news lands Wednesday through Friday, which is where the probabilities
-- actually move.
create or replace view pickem_movement as
select matchup, snapshot_date, pick, confidence, probabilities
from pickem_snapshots
order by matchup, snapshot_date;

-- Lock the tables down, then allow anonymous reads only. The cron writes with
-- the service role key, which bypasses RLS.
alter table pickem_snapshots enable row level security;
alter table pickem_runs      enable row level security;

drop policy if exists "public read snapshots" on pickem_snapshots;
create policy "public read snapshots" on pickem_snapshots
  for select to anon using (true);

drop policy if exists "public read runs" on pickem_runs;
create policy "public read runs" on pickem_runs
  for select to anon using (true);
