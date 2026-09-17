/**
 * Read-only JSON for the display page.
 *
 * Public on purpose - this is what the page fetches, so it takes no secret.
 * It reads with the service role key, which stays server-side and never
 * reaches the browser. That is only safe because every query here is fixed:
 * nothing from the request reaches a filter, and the rows returned are the
 * same ones `anon` may already read under the RLS policies in schema.sql.
 */
import { createClient } from '@supabase/supabase-js';

// Built on first use, for the same reason as refresh-picks.js: a throw at
// module scope kills the function before the handler can report what is wrong.
let supabaseClient = null;

function db() {
  if (supabaseClient) return supabaseClient;

  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`missing environment variable(s): ${missing.join(', ')}`);
  }

  supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return supabaseClient;
}

export default async function handler(req, res) {
  try {
    const supabase = db();

    const [current, runs] = await Promise.all([
      supabase.from('pickem_current').select('*'),
      supabase
        .from('pickem_runs')
        .select('snapshot_date, ran_at, games, tiebreaker, duration_ms, ok, error')
        .order('snapshot_date', { ascending: false })
        .limit(1),
    ]);

    if (current.error) throw current.error;
    if (runs.error) throw runs.error;

    const games = (current.data || []).sort(
      (a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0),
    );
    const lastRun = (runs.data || [])[0] || null;

    // Line movement for the games on the board, so the page can show which way
    // a number has drifted since the first snapshot of the week. Scoped to the
    // current matchups rather than the whole table, which grows every day.
    let movement = [];
    if (games.length) {
      const { data, error } = await supabase
        .from('pickem_movement')
        .select('matchup, snapshot_date, pick, confidence')
        .in('matchup', games.map((g) => g.matchup));
      if (error) throw error;
      movement = data || [];
    }

    // The data changes once a day, so let the edge serve it and keep the
    // free-tier database out of the request path for repeat visitors.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');

    return res.status(200).json({
      games,
      movement,
      tiebreaker: lastRun?.tiebreaker ?? null,
      updatedAt: lastRun?.ran_at ?? null,
      snapshotDate: lastRun?.snapshot_date ?? null,
      healthy: lastRun ? lastRun.ok !== false : null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
