/**
 * Diagnostic for the "Kalshi returns 0 games" blocker.
 *
 *   node scripts/debug-kalshi.mjs
 *
 * Read-only, no keys, no DB. Checks in order:
 *   1. which host answers
 *   2. whether the two series exist
 *   3. market counts with and without status=open
 *   4. one full market object, so the real field names are visible
 */

const HOSTS = [
  'https://api.elections.kalshi.com/trade-api/v2',
  'https://api.kalshi.com/trade-api/v2',
];

const SERIES = ['KXNFLGAME', 'KXNFLTOTAL'];

async function get(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, body, text: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, status: 0, body: null, text: String(err) };
  }
}

// --- 1. which host responds --------------------------------------------------
console.log('=== 1. host reachability ===');
let host = null;
for (const h of HOSTS) {
  const r = await get(`${h}/exchange/status`);
  console.log(`${h}  -> ${r.status} ${r.ok ? 'OK' : 'FAIL'} ${r.ok ? JSON.stringify(r.body) : r.text}`);
  if (r.ok && !host) host = h;
}
if (!host) {
  console.log('\nNo Kalshi host responded. Stopping.');
  process.exit(1);
}
console.log(`\nusing: ${host}`);

// --- 2. do the series exist? -------------------------------------------------
console.log('\n=== 2. series lookup ===');
for (const s of SERIES) {
  const r = await get(`${host}/series/${s}`);
  const title = r.body?.series?.title ?? r.body?.title ?? null;
  console.log(`${s} -> ${r.status} ${title ? JSON.stringify(title) : r.text}`);
}

// --- 3. market counts by status ---------------------------------------------
console.log('\n=== 3. market counts ===');
const variants = [
  { label: 'series_ticker=KXNFLGAME&status=open', qs: { series_ticker: 'KXNFLGAME', status: 'open' } },
  { label: 'series_ticker=KXNFLGAME (no status) ', qs: { series_ticker: 'KXNFLGAME' } },
  { label: 'series_ticker=KXNFLGAME&status=unopened', qs: { series_ticker: 'KXNFLGAME', status: 'unopened' } },
  { label: 'series_ticker=KXNFLGAME&status=active', qs: { series_ticker: 'KXNFLGAME', status: 'active' } },
];

let sample = null;
for (const v of variants) {
  const qs = new URLSearchParams({ limit: '1000', ...v.qs });
  const r = await get(`${host}/markets?${qs}`);
  const markets = r.body?.markets || [];
  const statuses = [...new Set(markets.map((m) => m.status))];
  console.log(
    `${v.label} -> ${r.status} count=${markets.length}` +
      (statuses.length ? `  statuses=${JSON.stringify(statuses)}` : '') +
      (r.ok ? '' : `  ${r.text}`),
  );
  if (!sample && markets.length) sample = markets;
}

// --- 4. dump one full market -------------------------------------------------
console.log('\n=== 4. sample market object ===');
if (!sample) {
  console.log('No markets returned by any variant.');
} else {
  console.log(JSON.stringify(sample[0], null, 2));

  console.log('\n=== 4b. subtitle-ish fields across first 6 markets ===');
  for (const m of sample.slice(0, 6)) {
    console.log({
      ticker: m.ticker,
      event_ticker: m.event_ticker,
      status: m.status,
      title: m.title,
      subtitle: m.subtitle,
      yes_sub_title: m.yes_sub_title,
      no_sub_title: m.no_sub_title,
      yes_bid: m.yes_bid,
      yes_ask: m.yes_ask,
      last_price: m.last_price,
      volume: m.volume,
      open_interest: m.open_interest,
    });
  }
}
