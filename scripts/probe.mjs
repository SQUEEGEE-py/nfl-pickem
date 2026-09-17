/**
 * Local sanity check. Run before wiring up Vercel or Supabase:
 *
 *   node scripts/probe.mjs
 *
 * Hits both public APIs with no keys and prints what came back. If Kalshi
 * changes a subtitle format or Polymarket renames a tag, this is where you
 * find out - not in a silent 3am cron failure.
 */

import {
  fetchKalshiGames,
  fetchPolymarketGames,
  fetchExpectedTotal,
  blendGames,
  currentSlate,
} from '../lib/markets.js';

const pct = (n) => `${(n * 100).toFixed(1)}%`;

const t0 = Date.now();

const [kalshiGames, polyGames] = await Promise.all([
  fetchKalshiGames(),
  fetchPolymarketGames(),
]);

// Count distinct matchups, not records. A source returning many records that
// collapse to a handful of games means the parser is picking up something other
// than the game-winner market - Polymarket once reported 178 "games" that were
// all spread and prop markets on a single Thursday night game.
const distinct = (games) => new Set(games.map((g) => g.teams.join('@'))).size;

for (const [name, games] of [['Kalshi', kalshiGames], ['Polymarket', polyGames]]) {
  const games_ = distinct(games);
  const dupes = games.length - games_;
  console.log(
    `${(name + ' games:').padEnd(18)}${games_}` +
      (dupes ? `  <- WARNING: ${games.length} records collapse to ${games_} games` : ''),
  );
}

const slate = currentSlate(blendGames(kalshiGames, polyGames));
console.log(`Current slate:    ${slate.length} games\n`);

for (const g of slate) {
  const only = g.sources.length === 1 ? `  [only ${g.sources[0]}]` : '';
  const diff = g.spread !== null && g.spread > 0.05 ? `  <- venues disagree by ${pct(g.spread)}` : '';
  console.log(
    `${g.matchup.padEnd(9)} ${g.pick.padEnd(4)} ${pct(g.confidence).padStart(6)}${only}${diff}`,
  );
}

const last = slate
  .filter((g) => g.kickoff && g.eventTicker)
  .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))
  .pop();

if (last) {
  const suffix = last.eventTicker.split('-')[1];
  const total = await fetchExpectedTotal(suffix);
  console.log(
    total
      ? `\nTiebreaker (${last.matchup}): ${total.expectedTotal} points, from ${total.rungs} strikes`
      : `\nTiebreaker (${last.matchup}): no totals ladder listed yet`,
  );
}

console.log(`\nDone in ${Date.now() - t0}ms`);

// The Hobby function limit is 10s. If this run is anywhere near that locally,
// it will time out on Vercel, where the network is no faster.
if (Date.now() - t0 > 6000) {
  console.warn('WARNING: slow enough to risk the 10s Hobby function timeout.');
}
