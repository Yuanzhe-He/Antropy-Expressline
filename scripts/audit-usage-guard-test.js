// Usage-guard regression. The guard is the alarm + auto-degrade on app_state DB
// I/O: count DB-penetration reads + writes per day, scream (deduped) in the logs
// when volume goes abnormal, and degrade the runaway behavior (drop FX auto
// writes / extend the read-cache TTL) without stopping the service. It must be
// pure in-memory (never write to the DB to count) and must NOT count cache hits.
//
// Asserts:
//   UNIT (guard alone): normal volume is silent; crossing a threshold alerts
//   once then dedups, re-alerts after the interval; severe reads flag a cache
//   extend; over-threshold writes flag auto-write degrade; counters + the
//   triggered-today flag reset at the day boundary.
//   INTEGRATION (guard + store + mocked db): cache hits are NOT counted (only DB
//   penetration is); status/counting introduce ZERO DB writes; an FX (auto)
//   write is dropped when over threshold while the cache still updates; a USER
//   write (admin) is never blocked.

const assert = require("node:assert/strict");
const path = require("node:path");

// Low thresholds so the unit section crosses them quickly. Read at call time.
process.env.APP_STATE_READ_WARN_THRESHOLD = "5";
process.env.APP_STATE_WRITE_WARN_THRESHOLD = "5";
process.env.APP_STATE_READ_SEVERE_MULTIPLIER = "2"; // severe at 10 reads
process.env.APP_STATE_GUARD_ALERT_INTERVAL_MS = "1000";

const guard = require("../src/lib/usage-guard");

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};

// Capture the loud alert lines so we can assert on dedup without spamming output.
let alertLines = [];
const realErr = console.error;
const startCapture = () => {
  alertLines = [];
  console.error = (...a) => alertLines.push(a.join(" "));
};
const stopCapture = () => {
  console.error = realErr;
};
const alertCount = () => alertLines.filter((l) => l.includes("[USAGE-GUARD-ALERT]")).length;

function setAtPath(obj, p, value) {
  let node = obj;
  for (let i = 0; i < p.length - 1; i += 1) {
    if (node[p[i]] === null || typeof node[p[i]] !== "object") node[p[i]] = {};
    node = node[p[i]];
  }
  node[p[p.length - 1]] = value;
}

async function unitTests() {
  // (normal) under threshold -> silent, no degrade, no false positive.
  guard.__resetForTest();
  guard.__setNowForTest(1_000_000);
  startCapture();
  for (let i = 0; i < 4; i += 1) guard.recordRead();
  for (let i = 0; i < 4; i += 1) guard.recordWrite();
  stopCapture();
  assert.equal(alertCount(), 0, "normal volume fires no alert");
  assert.equal(guard.shouldDegradeAutoWrite(), false, "under write threshold -> no degrade");
  assert.equal(guard.shouldExtendReadCache(), false, "under severe -> no cache extend");
  ok("normal volume: silent, no degrade (no false positive)");

  // (read alert + dedup + refire)
  guard.__resetForTest();
  guard.__setNowForTest(2_000_000);
  startCapture();
  for (let i = 0; i < 5; i += 1) guard.recordRead(); // reach threshold 5 -> alert #1
  assert.equal(alertCount(), 1, "crossing read threshold fires one alert");
  guard.recordRead(); // 6, within interval -> deduped
  guard.recordRead(); // 7, within interval -> deduped
  assert.equal(alertCount(), 1, "dedup: alarm does not become a log storm");
  guard.__setNowForTest(2_000_000 + 1001); // past the 1000ms interval
  guard.recordRead(); // 8 -> alert #2
  assert.equal(alertCount(), 2, "re-alerts once the interval elapses");
  stopCapture();
  ok("read alert: one on crossing, deduped within window, re-fires after interval");

  // (severe reads -> extend cache)
  guard.recordRead(); // 9
  guard.recordRead(); // 10 == threshold(5) * severe(2)
  assert.equal(guard.shouldExtendReadCache(), true, "severe read volume -> extend cache TTL");
  ok("read storm severe -> shouldExtendReadCache true (egress clamp)");

  // (write alert + auto-write degrade)
  guard.__resetForTest();
  guard.__setNowForTest(3_000_000);
  startCapture();
  for (let i = 0; i < 5; i += 1) guard.recordWrite(); // threshold 5 -> alert
  stopCapture();
  assert.equal(alertCount(), 1, "crossing write threshold fires one alert");
  assert.equal(guard.shouldDegradeAutoWrite(), true, "over write threshold -> degrade auto writes");
  ok("write alert + auto-write degrade at threshold");

  // (daily reset of counters + the triggered flag)
  guard.__resetForTest();
  guard.__setNowForTest(Date.parse("2026-06-21T10:00:00Z"));
  startCapture();
  for (let i = 0; i < 6; i += 1) guard.recordWrite(); // over threshold on day 1
  stopCapture();
  let s = guard.getStatus();
  assert.equal(s.writes, 6, "day-1 writes counted");
  assert.equal(s.triggeredToday, true, "day-1 alert flag set");
  guard.__setNowForTest(Date.parse("2026-06-22T00:01:00Z")); // next day
  startCapture();
  guard.recordWrite(); // rollDay resets, then counts 1
  stopCapture();
  s = guard.getStatus();
  assert.equal(s.writes, 1, "counters reset at day boundary");
  assert.equal(s.triggeredToday, false, "triggered-today flag resets on the new day");
  ok("daily reset: counters + triggered flag reset at the day boundary");
}

async function integrationTests() {
  // Mock the db layer but have the mock call the REAL guard, like db.js does, so
  // we can assert what reaches the DB vs what the cache absorbs.
  let getCalls = 0;
  let saveCalls = 0;
  let patchCalls = 0;
  const backing = {};
  const realGuard = require("../src/lib/usage-guard"); // same singleton store uses

  const fakeDb = {
    shouldUseDatabase: () => true,
    getAppState: async (k) => {
      getCalls += 1;
      realGuard.recordRead();
      return backing[k] ? structuredClone(backing[k]) : null;
    },
    saveAppState: async (k, p) => {
      saveCalls += 1;
      realGuard.recordWrite();
      backing[k] = structuredClone(p);
    },
    patchAppStateField: async (k, f, v) => {
      patchCalls += 1;
      realGuard.recordWrite();
      const p = Array.isArray(f) ? f : [f];
      if (!backing[k]) return 0;
      setAtPath(backing[k], p, structuredClone(v));
      return 1;
    },
    getDatabaseSchema: () => "expressline",
  };

  const dbPath = require.resolve(path.join(__dirname, "../src/lib/db"));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

  // High thresholds + a generous TTL so the cache section neither alerts nor extends.
  process.env.SHIPPING_CACHE_TTL_MS = "600000";
  process.env.APP_STATE_READ_WARN_THRESHOLD = "100000";
  process.env.APP_STATE_WRITE_WARN_THRESHOLD = "100000";

  const store = require("../src/lib/store");
  realGuard.__resetForTest();

  // (cache hits are NOT counted as DB reads)
  await store.getShippingData(); // warm-up: 1 DB read (+ seed write)
  const readsAfterWarm = realGuard.getStatus().reads;
  assert.ok(readsAfterWarm >= 1, "warm-up did a DB-penetration read");
  for (let i = 0; i < 50; i += 1) await store.getShippingData();
  assert.equal(
    realGuard.getStatus().reads,
    readsAfterWarm,
    "50 cache hits added ZERO DB-penetration reads"
  );
  ok("guard counts DB-penetration reads only — cache hits are not counted");

  // (pure in-memory: status/counting never write to the DB)
  const writesBefore = saveCalls + patchCalls;
  realGuard.getStatus();
  realGuard.shouldDegradeAutoWrite();
  realGuard.shouldExtendReadCache();
  realGuard.recordRead();
  realGuard.recordWrite();
  assert.equal(saveCalls + patchCalls, writesBefore, "guard introduced no DB writes");
  ok("guard is pure in-memory: counting/status never touch the DB");

  // (degrade asymmetry: FX auto-write dropped over threshold; user write passes)
  process.env.APP_STATE_WRITE_WARN_THRESHOLD = "1"; // any write puts us over
  realGuard.__resetForTest();
  let sd = await store.getShippingData();
  sd.modules.inland.destinations[0].name = "Guard Edit 1";
  await store.saveShippingData(sd); // USER write -> 1 write -> now over threshold
  assert.equal(realGuard.shouldDegradeAutoWrite(), true, "over write threshold after one write");

  const patchBeforeFx = patchCalls;
  const fx = await store.getShippingData();
  await store.saveExchangeRates({
    ...fx,
    exchangeRates: {
      pairs: [
        { base: "USD", quote: "MXN", rate: 18.5 },
        { base: "MXN", quote: "USD", rate: 0.054 },
      ],
      lastCheckedAt: "2026-06-21T00:00:00.000Z",
    },
  });
  assert.equal(patchCalls, patchBeforeFx, "FX auto-write DROPPED while degraded (no DB write)");
  const afterFx = await store.getShippingData();
  const rate = afterFx.exchangeRates.pairs.find((p) => p.base === "USD" && p.quote === "MXN");
  assert.equal(rate.rate, 18.5, "degraded FX still refreshed the in-memory cache");
  assert.ok(realGuard.getStatus().autoWritesDegraded >= 1, "degraded auto-write counted in status");

  const writesBeforeUser = patchCalls + saveCalls;
  sd = await store.getShippingData();
  sd.modules.inland.destinations[0].name = "Guard Edit 2";
  await store.saveShippingData(sd); // USER write while degraded
  assert.ok(patchCalls + saveCalls > writesBeforeUser, "USER write is NEVER blocked, even when degraded");
  ok("degrade asymmetry: FX(auto) dropped, admin(user) always writes; cache stays fresh");
}

async function main() {
  await unitTests();
  await integrationTests();
  console.log(`\naudit-usage-guard-test: ${passed}/${passed} passed`);
  console.log("audit-usage-guard-test-ok");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
