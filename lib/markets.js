/**
 * Market data for NFL pick'em.
 *
 * Two public, no-auth sources:
 *   Kalshi   https://api.elections.kalshi.com/trade-api/v2
 *            KXNFLGAME  - game winner, one market per team per game
 *            KXNFLTOTAL - combined points ladder, ~16 strikes per game
 *   Polymarket https://gamma-api.polymarket.com
 *            NFL game events, one market with two outcomes
 *
 * Nothing here requires an account, key, or payment.
 */

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const GAMMA = 'https://gamma-api.polymarket.com';

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

// Kalshi writes team names in market subtitles; Polymarket uses abbreviations
// in its event slugs. Both get resolved to these canonical abbreviations.
export const TEAMS = {
  ARI: ['arizona', 'cardinals'],
  ATL: ['atlanta', 'falcons'],
  BAL: ['baltimore', 'ravens'],
  BUF: ['buffalo', 'bills'],
  CAR: ['carolina', 'panthers'],
  CHI: ['chicago', 'bears'],
  CIN: ['cincinnati', 'bengals'],
  CLE: ['cleveland', 'browns'],
  DAL: ['dallas', 'cowboys'],
  DEN: ['denver', 'broncos'],
  DET: ['detroit', 'lions'],
  GB: ['green bay', 'packers', 'gnb'],
  HOU: ['houston', 'texans'],
  IND: ['indianapolis', 'colts'],
  JAX: ['jacksonville', 'jaguars', 'jac'],
  KC: ['kansas city', 'chiefs', 'kan'],
  LAC: ['los angeles chargers', 'los angeles c', 'chargers', 'san diego'],
  LAR: ['los angeles rams', 'los angeles r', 'rams', 'st louis'],
  LV: ['las vegas', 'raiders', 'oakland', 'lvr', 'oak'],
  MIA: ['miami', 'dolphins'],
  MIN: ['minnesota', 'vikings'],
  NE: ['new england', 'patriots', 'nwe'],
  NO: ['new orleans', 'saints', 'nor'],
  NYG: ['new york giants', 'new york g', 'giants'],
  NYJ: ['new york jets', 'new york j', 'jets'],
  PHI: ['philadelphia', 'eagles'],
  PIT: ['pittsburgh', 'steelers'],
  SEA: ['seattle', 'seahawks'],
  SF: ['san francisco', '49ers', 'niners', 'sfo'],
  TB: ['tampa bay', 'buccaneers', 'bucs', 'tam'],
  TEN: ['tennessee', 'titans'],
  WAS: ['washington', 'commanders', 'wsh'],
};

const LOOKUP = (() => {
  const m = new Map();
  for (const [abbr, aliases] of Object.entries(TEAMS)) {
    m.set(abbr.toLowerCase(), abbr);
    for (const a of aliases) m.set(a, abbr);
  }
  return m;
})();

/**
 * Resolve a free-text team reference to a canonical abbreviation.
 * Longest alias wins, so "los angeles rams" beats a bare "los angeles".
 */
export function resolveTeam(text) {
  if (!text) return null;
  const s = String(text).toLowerCase().trim();
  if (LOOKUP.has(s)) return LOOKUP.get(s);

  let best = null;
  let bestLen = 0;
  for (const [alias, abbr] of LOOKUP) {
    if (alias.length > bestLen && s.includes(alias)) {
      best = abbr;
      bestLen = alias.length;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

/**
 * First value that is actually present, as a number. Kalshi returns its decimal
 * fields as strings ("0.4700", "2341.13"), so Number() is required before any
 * arithmetic; absent fields and empty strings are not zeroes.
 */
function firstNumber(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Midpoint of the bid/ask, as a probability in [0,1].
 *
 * Kalshi now quotes dollars as strings (yes_bid_dollars: "0.4700"); the older
 * shape quoted whole cents as numbers (yes_bid: 47). Both are accepted and
 * normalized to [0,1]. Last-trade price goes stale on thin midweek markets, so
 * the book midpoint is the honest read; last price is only a fallback for a
 * market with no book at all.
 */
export function midProbability(mk = {}) {
  const price = (dollarField, centField) => {
    const d = firstNumber(dollarField);
    if (d !== null) return d;
    const c = firstNumber(centField);
    return c === null ? 0 : c / 100;
  };

  const bid = price(mk.yes_bid_dollars, mk.yes_bid);
  const ask = price(mk.yes_ask_dollars, mk.yes_ask);
  const last = price(mk.last_price_dollars, mk.last_price);

  // A zero bid is a real quote on a deep out-of-the-money strike, so only a
  // missing ask means there is no book to read.
  if (ask > 0 && ask >= bid) return (bid + ask) / 2;
  if (last > 0) return last;
  return null;
}

/** Force two complementary probabilities to sum to exactly 1. */
export function normalizePair(pA, pB) {
  const sum = pA + pB;
  if (!sum) return [0.5, 0.5];
  return [pA / sum, pB / sum];
}

// ---------------------------------------------------------------------------
// Kalshi
// ---------------------------------------------------------------------------

async function kalshiMarkets(params) {
  const out = [];
  let cursor = '';

  // Paginate, but cap the loop. A runaway cursor would blow the 10s Hobby
  // function timeout and the invocation would die silently with no retry.
  for (let page = 0; page < 8; page++) {
    const qs = new URLSearchParams({ limit: '1000', ...params });
    if (cursor) qs.set('cursor', cursor);

    const res = await fetch(`${KALSHI}/markets?${qs}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Kalshi ${res.status} on ${qs}`);

    const body = await res.json();
    out.push(...(body.markets || []));
    cursor = body.cursor || '';
    if (!cursor || !body.markets?.length) break;
  }
  return out;
}

/**
 * Parse the date out of an event ticker like KXNFLGAME-26SEP13NYJTEN.
 *
 * Deliberately does NOT parse the teams. The trailing team block is ambiguous
 * ("LARKC" could split as LAR+KC or LA+RKC), so teams come from the market
 * subtitles instead, which are unambiguous.
 */
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

export function eventDate(eventTicker) {
  const suffix = String(eventTicker).split('-')[1] || '';
  const m = suffix.match(/^(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return null;
  const [, yy, mon, dd] = m;
  if (!(mon in MONTHS)) return null;
  return new Date(Date.UTC(2000 + Number(yy), MONTHS[mon], Number(dd)));
}

/**
 * Fetch open game-winner markets and fold them into one record per game.
 */
export async function fetchKalshiGames() {
  const markets = await kalshiMarkets({ series_ticker: 'KXNFLGAME', status: 'open' });

  const byEvent = new Map();
  for (const mk of markets) {
    const team = resolveTeam(mk.yes_sub_title || mk.subtitle || mk.title);
    const prob = midProbability(mk);
    if (!team || prob === null) continue;

    if (!byEvent.has(mk.event_ticker)) {
      byEvent.set(mk.event_ticker, {
        eventTicker: mk.event_ticker,
        date: eventDate(mk.event_ticker),
        // close_time sits ~2 days past kickoff because it waits for
        // settlement, so it is useless as a start time. occurrence_datetime is
        // the scheduled kickoff, and is what the slate window and the
        // tiebreaker sort actually need.
        startTime: mk.occurrence_datetime || null,
        closeTime: mk.close_time,
        sides: [],
      });
    }
    byEvent.get(mk.event_ticker).sides.push({
      team,
      prob,
      volume: firstNumber(mk.volume_fp, mk.volume) ?? 0,
      openInterest: firstNumber(mk.open_interest_fp, mk.open_interest) ?? 0,
      ticker: mk.ticker,
    });
  }

  const games = [];
  for (const ev of byEvent.values()) {
    if (ev.sides.length !== 2) continue; // half-listed game; skip rather than guess
    const [a, b] = ev.sides;
    const [pa, pb] = normalizePair(a.prob, b.prob);
    games.push({
      eventTicker: ev.eventTicker,
      date: ev.date,
      startTime: ev.startTime,
      closeTime: ev.closeTime,
      teams: [a.team, b.team].sort(),
      kalshi: {
        [a.team]: pa,
        [b.team]: pb,
      },
      kalshiWeight: a.volume + b.volume + a.openInterest + b.openInterest,
    });
  }
  return games;
}

/**
 * The combined-points ladder for one game, as expected total points.
 *
 * Each strike is a separate market: "Over 32.5 points" priced at 70c means
 * P(total > 32.5) = 0.70. Sixteen of those give a full survival curve, which
 * is a much better tiebreaker estimate than eyeballing a single over/under.
 */
export async function fetchExpectedTotal(gameEventSuffix) {
  const eventTicker = `KXNFLTOTAL-${gameEventSuffix}`;
  const markets = await kalshiMarkets({ event_ticker: eventTicker, status: 'open' });

  const rungs = [];
  for (const mk of markets) {
    // floor_strike carries the strike as a number (69.5). Read it out of
    // "Over 69.5 points scored" only if that field is missing.
    const fromText = String(mk.yes_sub_title || mk.title || '').match(/(\d+(?:\.\d+)?)/);
    const strike = firstNumber(mk.floor_strike, fromText?.[1]);
    const prob = midProbability(mk);
    if (strike === null || prob === null) continue;
    rungs.push({ strike, prob });
  }
  if (rungs.length < 3) return null;

  rungs.sort((x, y) => x.strike - y.strike);

  // Survival must be non-increasing. Thin strikes sometimes violate this by a
  // cent or two; clamp instead of letting it produce negative bucket mass.
  for (let i = 1; i < rungs.length; i++) {
    rungs[i].prob = Math.min(rungs[i].prob, rungs[i - 1].prob);
  }

  const gaps = rungs.slice(1).map((r, i) => r.strike - rungs[i].strike);
  const step = gaps.reduce((s, g) => s + g, 0) / (gaps.length || 1) || 3;

  // Bucket mass between consecutive strikes, placed at the bucket midpoint,
  // plus a tail on each end half a step beyond the outermost strike.
  let ev = 0;
  let mass = 0;

  const lowMass = 1 - rungs[0].prob;
  ev += lowMass * Math.max(0, rungs[0].strike - step / 2);
  mass += lowMass;

  for (let i = 1; i < rungs.length; i++) {
    const m = rungs[i - 1].prob - rungs[i].prob;
    ev += m * ((rungs[i - 1].strike + rungs[i].strike) / 2);
    mass += m;
  }

  const highMass = rungs[rungs.length - 1].prob;
  ev += highMass * (rungs[rungs.length - 1].strike + step / 2);
  mass += highMass;

  if (mass <= 0) return null;

  return {
    expectedTotal: Math.round((ev / mass) * 10) / 10,
    rungs: rungs.length,
    eventTicker,
  };
}

// ---------------------------------------------------------------------------
// Polymarket
// ---------------------------------------------------------------------------

/**
 * Parse a Polymarket timestamp.
 *
 * `endDate` is proper ISO, but `gameStartTime` comes back as
 * "2026-09-18 00:15:00+00" - a space instead of the T and a two-digit offset,
 * which is not ISO 8601 and is not portably parseable. Normalize before
 * handing it to Date.
 */
function polyTime(...vals) {
  for (const v of vals) {
    if (!v) continue;
    const d = new Date(String(v).trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

// Gamma caps `limit` at 100 no matter what is asked for, and with no `order`
// it returns oldest-listed first - which is why an unbounded tag_slug=nfl query
// came back full of championship futures and celebrity props with a single real
// game in it. Bound the query by kickoff instead. For a game event `endDate` is
// the kickoff, so ordering by it ascending puts the next games first and one
// page comfortably covers a full slate (~38 events for a 7-day window).
const POLY_LOOKBACK_MS = 6 * 3600 * 1000;
const POLY_WINDOW_MS = 7 * 86400000;

/**
 * Fetch NFL game events for roughly the next week, one record per game.
 *
 * Only the `moneyline` market is a game winner. Every event also carries ~280
 * spread, total, and prop markets, and the spread markets have the same two
 * team names as their outcomes - taking those too is what previously turned one
 * game into 178 "games".
 *
 * `outcomes` and `outcomePrices` arrive as JSON-encoded strings, not arrays,
 * which is the usual first thing to break.
 */
export async function fetchPolymarketGames(now = Date.now()) {
  const qs = new URLSearchParams({
    tag_slug: 'nfl',
    closed: 'false',
    limit: '100',
    order: 'endDate',
    ascending: 'true',
    end_date_min: new Date(now - POLY_LOOKBACK_MS).toISOString(),
    end_date_max: new Date(now + POLY_WINDOW_MS).toISOString(),
  });
  const res = await fetch(`${GAMMA}/events?${qs}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Polymarket ${res.status}`);

  const events = await res.json();
  const games = [];

  for (const ev of Array.isArray(events) ? events : []) {
    // Prop-only companion events (…-player-props, …-first-td-scorer) carry the
    // same teams as the game event but no moneyline, so this also drops them.
    const mk = (ev.markets || []).find((m) => m.sportsMarketType === 'moneyline');
    if (!mk) continue;

    let outcomes, prices;
    try {
      outcomes = JSON.parse(mk.outcomes || '[]');
      prices = JSON.parse(mk.outcomePrices || '[]');
    } catch {
      continue;
    }
    if (outcomes.length !== 2 || prices.length !== 2) continue;

    // Outcomes are nicknames ("Cowboys", "Eagles"). Resolve from those rather
    // than the slug, whose abbreviations are not the canonical ones - the Rams
    // appear as "la" in nfl-nyg-la-2026-09-22.
    const a = resolveTeam(outcomes[0]);
    const b = resolveTeam(outcomes[1]);
    if (!a || !b || a === b) continue;

    const [pa, pb] = normalizePair(Number(prices[0]) || 0, Number(prices[1]) || 0);

    games.push({
      teams: [a, b].sort(),
      date: polyTime(ev.endDate, mk.gameStartTime, ev.startDate),
      slug: ev.slug,
      poly: { [a]: pa, [b]: pb },
      polyWeight:
        (firstNumber(mk.volumeNum, mk.volume) ?? 0) + (firstNumber(mk.liquidityNum, mk.liquidity) ?? 0),
    });
  }
  return games;
}

// ---------------------------------------------------------------------------
// Join + blend
// ---------------------------------------------------------------------------

const matchKey = (teams, date) => {
  const d = date ? new Date(date) : null;
  const day = d ? d.toISOString().slice(0, 10) : 'nodate';
  return `${teams.join('@')}|${day}`;
};

/**
 * Merge the two sources into one row per game.
 *
 * Weighted by volume, so a $4M Kalshi market outweighs a $30k Polymarket one
 * rather than tying with it. Games present in only one source still come
 * through, flagged, instead of being silently dropped.
 */
export function blendGames(kalshiGames, polyGames) {
  const byKey = new Map();

  for (const g of kalshiGames) {
    byKey.set(matchKey(g.teams, g.date), { ...g, sources: ['kalshi'] });
  }

  for (const p of polyGames) {
    // Kickoff can land on a different UTC day between sources, so try the
    // exact day first and then the days either side before giving up.
    const candidates = [0, -1, 1].map((off) => {
      const d = p.date ? new Date(p.date.getTime() + off * 86400000) : null;
      return matchKey(p.teams, d);
    });

    const hit = candidates.find((k) => byKey.has(k));
    if (hit) {
      const row = byKey.get(hit);
      row.poly = p.poly;
      row.polyWeight = p.polyWeight;
      row.polySlug = p.slug;
      row.polyDate = p.date;
      row.sources.push('polymarket');
    } else {
      byKey.set(candidates[0], { ...p, teams: p.teams, polyDate: p.date, sources: ['polymarket'] });
    }
  }

  const rows = [];
  for (const g of byKey.values()) {
    const [t1, t2] = g.teams;
    const kw = g.kalshi ? Math.max(g.kalshiWeight || 0, 1) : 0;
    const pw = g.poly ? Math.max(g.polyWeight || 0, 1) : 0;
    const total = kw + pw;
    if (!total) continue;

    const blend = (team) =>
      ((g.kalshi?.[team] ?? 0) * kw + (g.poly?.[team] ?? 0) * pw) / total;

    const p1 = blend(t1);
    const p2 = blend(t2);
    const [n1, n2] = normalizePair(p1, p2);

    const pick = n1 >= n2 ? t1 : t2;
    const confidence = Math.max(n1, n2);

    rows.push({
      eventTicker: g.eventTicker || null,
      polySlug: g.polySlug || g.slug || null,
      // Polymarket's endDate is the real kickoff. Kalshi's occurrence_datetime
      // runs a uniform three hours late on every game (it is closer to when the
      // game ends), so it is only a fallback for games Polymarket has not
      // listed yet. Both beat close_time, which is ~2 days past kickoff.
      kickoff: g.polyDate || g.startTime || g.date || g.closeTime || null,
      matchup: `${t1}@${t2}`,
      teams: g.teams,
      pick,
      confidence: Math.round(confidence * 1000) / 1000,
      probabilities: { [t1]: round3(n1), [t2]: round3(n2) },
      kalshi: g.kalshi ? { [t1]: round3(g.kalshi[t1]), [t2]: round3(g.kalshi[t2]) } : null,
      polymarket: g.poly ? { [t1]: round3(g.poly[t1]), [t2]: round3(g.poly[t2]) } : null,
      // Disagreement between venues is the interesting signal: it usually means
      // one side has priced news the other hasn't yet.
      spread: g.kalshi && g.poly ? round3(Math.abs(g.kalshi[t1] - g.poly[t1])) : null,
      sources: g.sources,
    });
  }

  rows.sort((a, b) => b.confidence - a.confidence);
  return rows;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Pick out the current slate: the earliest *upcoming* game and everything
 * within six days of it. Avoids hardcoding a week number or a season start.
 *
 * Anchoring on upcoming games matters because Polymarket lists games that have
 * already been played. Anchoring on the earliest game in the whole set dragged
 * the window into the past and collapsed the slate to a single game.
 *
 * Six days, not seven: an NFL week runs Thursday night to Monday night, and the
 * next Thursday is exactly seven days after this one, so a seven-day window
 * catches the following week's opener. Six separates them cleanly.
 */
const SLATE_LOOKBACK_MS = 6 * 3600 * 1000; // keep games already in progress
const SLATE_WINDOW_MS = 6 * 86400000;

export function currentSlate(games, now = Date.now()) {
  const dated = games
    .filter((g) => g.kickoff)
    .map((g) => ({ game: g, time: new Date(g.kickoff).getTime() }))
    .filter((g) => Number.isFinite(g.time));
  if (!dated.length) return games;

  const upcoming = dated.filter((g) => g.time >= now - SLATE_LOOKBACK_MS);
  if (!upcoming.length) return [];

  const first = Math.min(...upcoming.map((g) => g.time));
  const cutoff = first + SLATE_WINDOW_MS;

  return upcoming
    .filter((g) => g.time <= cutoff)
    .sort((a, b) => b.game.confidence - a.game.confidence)
    .map((g) => g.game);
}
