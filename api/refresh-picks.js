import { createClient } from '@supabase/supabase-js';
import {
  fetchKalshiGames,
  fetchPolymarketGames,
  fetchExpectedTotal,
  blendGames,
  currentSlate,
} from '../lib/markets.js';

// Built on first use, not at import time. createClient throws if the URL is
// missing, and a throw at module scope kills the function before the handler
// runs - which means the catch below never fires and pickem_runs records
// nothing at all. A missing env var is the most likely first-deploy failure
// (they only apply to deployments created after they are set), so it has to
// surface as a recorded failed run rather than an opaque crash.
let supabaseClient = null;

function db() {
  if (supabaseClient) return supabaseClient;

  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`missing environment variable(s): ${missing.join(', ')}`);
  }

  supabaseClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY, // server-side only, never in the client bundle
  );
  return supabaseClient;
}

export default async function handler(req, res) {
  // Vercel sends Authorization: Bearer $CRON_SECRET. Without this check the
  // route is a public URL anyone can hammer.
  //
  // Fail closed when deployed: if CRON_SECRET is simply absent, skipping the
  // check would quietly leave the endpoint open to anyone who guesses the path.
  // Locally (no VERCEL env var) it stays optional so the route can be run by
  // hand without setting anything up.
  if (!process.env.CRON_SECRET) {
    if (process.env.VERCEL) {
      return res.status(500).json({ error: 'CRON_SECRET is not set' });
    }
  } else if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const startedAt = Date.now();

  try {
    // Both sources in parallel. Serial fetching is what pushes this past the
    // 10s Hobby function limit.
    const [kalshiGames, polyGames] = await Promise.all([
      fetchKalshiGames(),
      fetchPolymarketGames(),
    ]);

    const slate = currentSlate(blendGames(kalshiGames, polyGames));
    if (!slate.length) {
      throw new Error('no games resolved from either source');
    }

    // Tiebreaker: only the last game of the slate needs a totals ladder, so
    // this stays at one extra request instead of sixteen.
    const lastGame = slate
      .filter((g) => g.kickoff && g.eventTicker)
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
      .pop();

    let tiebreaker = null;
    if (lastGame) {
      const suffix = lastGame.eventTicker.split('-')[1];
      try {
        const total = await fetchExpectedTotal(suffix);
        if (total) {
          tiebreaker = {
            matchup: lastGame.matchup,
            kickoff: lastGame.kickoff,
            expected_total: total.expectedTotal,
            rungs: total.rungs,
          };
        }
      } catch (err) {
        // A missing totals ladder shouldn't lose the whole winner slate.
        console.error('totals ladder failed:', err.message);
      }
    }

    const snapshotDate = new Date().toISOString().slice(0, 10);

    const rows = slate.map((g) => ({
      snapshot_date: snapshotDate,
      matchup: g.matchup,
      kickoff: g.kickoff ? new Date(g.kickoff).toISOString() : null,
      pick: g.pick,
      confidence: g.confidence,
      probabilities: g.probabilities,
      kalshi: g.kalshi,
      polymarket: g.polymarket,
      venue_spread: g.spread,
      sources: g.sources,
    }));

    const { error: rowsError } = await db()
      .from('pickem_snapshots')
      .upsert(rows, { onConflict: 'snapshot_date,matchup' });
    if (rowsError) throw rowsError;

    const { error: runError } = await db().from('pickem_runs').upsert(
      {
        snapshot_date: snapshotDate,
        ran_at: new Date().toISOString(),
        games: rows.length,
        tiebreaker,
        duration_ms: Date.now() - startedAt,
        ok: true,
        error: null,
      },
      { onConflict: 'snapshot_date' },
    );
    if (runError) throw runError;

    return res.status(200).json({ ok: true, games: rows.length, tiebreaker });
  } catch (err) {
    // Vercel does not retry or alert on a failed cron invocation, on any plan.
    // Recording the failure is the only way you find out it stopped working.
    //
    // This write can itself fail - a bad key, a paused project, or the very
    // env var problem being reported. Let that not replace the original error
    // with a less useful one.
    try {
      await db().from('pickem_runs').upsert(
        {
          snapshot_date: new Date().toISOString().slice(0, 10),
          ran_at: new Date().toISOString(),
          games: 0,
          ok: false,
          error: String(err.message || err).slice(0, 500),
          duration_ms: Date.now() - startedAt,
        },
        { onConflict: 'snapshot_date' },
      );
    } catch (logErr) {
      console.error('could not record the failed run:', logErr.message);
    }

    console.error(err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
