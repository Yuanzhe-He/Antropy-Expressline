// A — FX write-storm fix regression. The prod storm was a forced FX refresh
// hammered ~every 2s; each call re-fetched + wrote (only lastCheckedAt advanced),
// ~28k writes/day. The fix throttles refreshes (even forced) to at most once per
// MIN_REFRESH_INTERVAL_MS. This test guards that throttle without hitting the
// network for the throttled cases.

const assert = require("node:assert/strict");
const {
  refreshExchangeRatesIfStale,
  needsExchangeRateRefresh,
} = require("../src/lib/exchange-rates");

const PAIRS = [
  { base: "USD", quote: "MXN", rate: 17.3 },
  { base: "MXN", quote: "USD", rate: 0.0578 },
];
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS ", m); };

async function main() {
  // needsExchangeRateRefresh basics
  assert.equal(needsExchangeRateRefresh({ pairs: PAIRS, lastCheckedAt: `${today}T03:00:00.000Z` }), false, "fresh today -> not stale");
  assert.equal(needsExchangeRateRefresh({ pairs: PAIRS, lastCheckedAt: `${yesterday}T03:00:00.000Z` }), true, "yesterday -> stale");
  assert.equal(needsExchangeRateRefresh({ pairs: [], lastCheckedAt: `${today}T03:00:00.000Z` }), true, "no pairs -> stale");
  assert.equal(needsExchangeRateRefresh({ pairs: PAIRS }), true, "no lastCheckedAt -> stale");
  ok("needsExchangeRateRefresh: daily staleness gate correct");

  // THROTTLE: forced refresh, just checked -> no fetch/write (changed:false)
  const justNow = { exchangeRates: { pairs: PAIRS, lastCheckedAt: new Date().toISOString(), asOfDate: today } };
  const r1 = await refreshExchangeRatesIfStale(justNow, { force: true });
  assert.equal(r1.changed, false, "forced + checked-just-now is THROTTLED (no write)");
  ok("throttle: forced refresh within window does NOT write (storm capped)");

  // non-forced + fresh today -> no change
  const r2 = await refreshExchangeRatesIfStale(justNow, {});
  assert.equal(r2.changed, false, "non-forced + fresh -> no change");
  ok("non-forced + fresh today does not refresh");

  // forced + recently-checked 1min ago -> still throttled (default window 15min)
  const oneMinAgo = { exchangeRates: { pairs: PAIRS, lastCheckedAt: new Date(Date.now() - 60 * 1000).toISOString(), asOfDate: today } };
  const r3 = await refreshExchangeRatesIfStale(oneMinAgo, { force: true });
  assert.equal(r3.changed, false, "forced + 1min-ago still throttled");
  ok("throttle: a 2s-poller is capped to <=1 write per window");

  // forced + last-checked older than the window -> throttle passes (would fetch).
  // Allow network success (changed:true) OR a network failure (catch -> changed:true
  // with lastError). Either way the throttle did NOT block it.
  const longAgo = { exchangeRates: { pairs: PAIRS, lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), asOfDate: yesterday } };
  const r4 = await refreshExchangeRatesIfStale(longAgo, { force: true });
  assert.equal(r4.changed, true, "forced + older-than-window passes the throttle (refresh attempted)");
  ok("throttle: forced refresh after the window still works (manual button + scheduler ok)");

  console.log(`\naudit-fx-throttle-test: ${passed}/${passed} passed`);
  console.log("audit-fx-throttle-test-ok");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
