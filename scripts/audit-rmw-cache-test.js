// RMW-loop killshot regression. The prod egress storm was the READ path:
// getShippingData() pulled the whole ~1.6MB shipping-data blob from Postgres on
// EVERY hit of any of the 59 routes behind server.loadShippingData() — an
// external client hitting /exchange-rates/refresh ~every 2s turned into 218k
// full-blob reads (~350GB egress) that blew through Supabase's free tier.
//
// This test mocks the db layer (no real Postgres) to assert, in DB mode:
//   1. the read path serves from an in-process cache (N reads => 1 DB pull);
//   2. reads hand out independent clones (a caller cannot corrupt the cache);
//   3. a single-module save is a targeted jsonb_set, not a full-blob overwrite;
//   4. a no-op save writes nothing at all (the lastCheckedAt-spin bug class);
//   5. a cross-module save falls back to a full overwrite;
//   6. saveExchangeRates patches only {exchangeRates} and refreshes that slice;
//   7. a module save never rolls back a concurrent FX update (exchangeRates pin);
//   8. the operator immediately sees their own write (write-through cache);
//   9. the TTL bounds staleness (TTL=0 forces a fresh pull; multi-instance net).

const assert = require("node:assert/strict");
const path = require("node:path");

// --- mock the db layer BEFORE store.js requires it -------------------------
let getCount = 0;
let saveCount = 0;
let patchCount = 0;
const lastPatch = { path: null };
const backing = {}; // key -> stored payload (deep-copied, like a JSON round-trip)

function setAtPath(obj, p, value) {
  let node = obj;
  for (let i = 0; i < p.length - 1; i += 1) {
    if (node[p[i]] === null || typeof node[p[i]] !== "object") node[p[i]] = {};
    node = node[p[i]];
  }
  node[p[p.length - 1]] = value;
}

const fakeDb = {
  shouldUseDatabase: () => true,
  getAppState: async (key) => {
    getCount += 1;
    return backing[key] ? structuredClone(backing[key]) : null;
  },
  saveAppState: async (key, payload) => {
    saveCount += 1;
    backing[key] = structuredClone(payload); // pg stores a copy, never aliases
  },
  patchAppStateField: async (key, field, value) => {
    patchCount += 1;
    const p = Array.isArray(field) ? field : [field];
    lastPatch.path = p.join(".");
    if (!backing[key]) return 0;
    setAtPath(backing[key], p, structuredClone(value));
    return 1;
  },
  // store.js does not call these, but keep the shape complete.
  getDatabaseSchema: () => "expressline",
  saveUsers: undefined,
};

const dbPath = require.resolve(path.join(__dirname, "../src/lib/db"));
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakeDb,
};

// Generous TTL by default so the cache stays warm across the test.
process.env.SHIPPING_CACHE_TTL_MS = "600000";

const store = require("../src/lib/store");

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};
const resetCounters = () => {
  getCount = 0;
  saveCount = 0;
  patchCount = 0;
  lastPatch.path = null;
};

async function main() {
  // Warm-up: first read seeds the store (getAppState null -> seed -> saveAppState)
  // and populates the cache. We measure cache behavior AFTER this.
  const first = await store.getShippingData();
  assert.ok(first && first.modules && first.modules.handover, "seed produced modules");
  assert.ok(getCount >= 1, "warm-up did at least one DB read");
  resetCounters();

  // (1) Read cache: 100 reads => 0 additional DB pulls. THE killshot.
  for (let i = 0; i < 100; i += 1) {
    await store.getShippingData();
  }
  assert.equal(getCount, 0, "100 reads after warm-up did ZERO DB pulls (cache hits)");
  assert.equal(saveCount, 0, "reads never write");
  ok("read cache: 100 reads collapse to 0 DB pulls (218k -> ~0 egress)");

  // (2) Reads hand out independent clones — caller mutation cannot corrupt cache.
  const a = await store.getShippingData();
  a.modules.handover = { tampered: true };
  a.exchangeRates = { hacked: true };
  const b = await store.getShippingData();
  assert.notDeepEqual(b.modules.handover, { tampered: true }, "cache not corrupted by caller");
  assert.ok(b.modules.handover && !b.modules.handover.tampered, "fresh clone per read");
  ok("read isolation: returned objects are independent clones");

  // (3) Single-module save => targeted jsonb_set, NOT a full overwrite. Use the
  // inland module (independent — it does not mirror to any other module, unlike
  // handover container types which cascade to customs), renaming an existing
  // destination (a field the normalizer preserves).
  resetCounters();
  const s1 = await store.getShippingData();
  assert.ok(s1.modules.inland.destinations.length > 0, "inland has destinations to rename");
  s1.modules.inland.destinations[0].name = "RMW Single-Module Edit";
  await store.saveShippingData(s1);
  assert.equal(saveCount, 0, "single-module save did NOT do a full-blob saveAppState");
  assert.equal(patchCount, 1, "single-module save did exactly one targeted patch");
  assert.equal(lastPatch.path, "modules.inland", "patched only {modules,inland}");
  ok("targeted write: single-module save is one jsonb_set, no full-blob overwrite");

  // (8) Write-through: operator immediately sees their own change, no DB read.
  resetCounters();
  const afterSave = await store.getShippingData();
  assert.equal(getCount, 0, "read after save served from cache (no DB pull)");
  assert.equal(
    afterSave.modules.inland.destinations[0].name,
    "RMW Single-Module Edit",
    "operator sees their own just-saved change"
  );
  ok("write-through: operator sees own change immediately with no DB pull");

  // (4) No-op save writes nothing.
  resetCounters();
  const noop = await store.getShippingData();
  await store.saveShippingData(noop); // identical, nothing changed
  assert.equal(saveCount, 0, "no-op save did no full write");
  assert.equal(patchCount, 0, "no-op save did no targeted write");
  ok("no-change-no-write: identical save persists nothing");

  // (5) Cross-module save => full overwrite fallback. Adding a handover container
  // type cascades to the customs mirror, so two sections (modules.handover +
  // modules.customs) change at once — exactly the case that must NOT be split
  // into partial patches.
  resetCounters();
  const s2 = await store.getShippingData();
  const baseRateGroup = s2.modules.handover.containerTypes?.[0]?.rateGroup || "dry";
  s2.modules.handover.containerTypes = [
    ...(s2.modules.handover.containerTypes || []),
    { key: "rmw-cascade-ct", label: "RMW Cascade", rateGroup: baseRateGroup },
  ];
  await store.saveShippingData(s2);
  assert.equal(saveCount, 1, "cross-module save did one full overwrite");
  assert.equal(patchCount, 0, "cross-module save did not do a partial patch");
  const afterCascade = await store.getShippingData();
  assert.ok(
    afterCascade.modules.handover.containerTypes.some((t) => t.key === "rmw-cascade-ct"),
    "cascade save persisted the handover change"
  );
  assert.ok(
    afterCascade.modules.customs.containerTypes.some((t) => t.key === "rmw-cascade-ct"),
    "cascade save mirrored to customs (proves >1 section changed -> full write)"
  );
  ok("full-write fallback: multi-section (handover+customs mirror) writes whole blob once");

  // (6) saveExchangeRates patches only {exchangeRates} and refreshes that slice.
  resetCounters();
  const fx = await store.getShippingData();
  const newRates = {
    ...fx.exchangeRates,
    pairs: [
      { base: "USD", quote: "MXN", rate: 19.99 },
      { base: "MXN", quote: "USD", rate: 0.05 },
    ],
    lastCheckedAt: "2026-06-20T12:00:00.000Z",
  };
  await store.saveExchangeRates({ ...fx, exchangeRates: newRates });
  assert.equal(saveCount, 0, "FX save did not full-overwrite");
  assert.equal(patchCount, 1, "FX save did one targeted patch");
  assert.equal(lastPatch.path, "exchangeRates", "FX patched only {exchangeRates}");
  const afterFx = await store.getShippingData();
  assert.equal(getCount, 0, "read after FX patch served from cache (no DB pull)");
  const usdMxn = afterFx.exchangeRates.pairs.find((p) => p.base === "USD" && p.quote === "MXN");
  assert.equal(usdMxn.rate, 19.99, "cache reflects the new FX rate immediately");
  ok("FX targeted write: {exchangeRates} patched + cache slice refreshed");

  // (7) exchangeRates pin: a module save that carries a STALE FX snapshot must
  // NOT roll back the concurrent FX update above.
  resetCounters();
  const staleAdmin = await store.getShippingData();
  // Simulate the admin having loaded an OLD FX snapshot before the FX patch.
  staleAdmin.exchangeRates = {
    pairs: [{ base: "USD", quote: "MXN", rate: 1.0 }],
    lastCheckedAt: "2000-01-01T00:00:00.000Z",
  };
  staleAdmin.modules.inland.destinations[0].name = "RMW Pin Edit";
  await store.saveShippingData(staleAdmin);
  const afterAdmin = await store.getShippingData();
  const pinned = afterAdmin.exchangeRates.pairs.find((p) => p.base === "USD" && p.quote === "MXN");
  assert.equal(pinned.rate, 19.99, "module save did NOT clobber the live FX rate (pin held)");
  assert.equal(
    afterAdmin.modules.inland.destinations[0].name,
    "RMW Pin Edit",
    "module save still persisted the module change"
  );
  ok("FX pin: a stale module save cannot roll back a concurrent FX update");

  // (9) TTL: set TTL=0 -> next read must pull fresh from DB (multi-instance net).
  resetCounters();
  process.env.SHIPPING_CACHE_TTL_MS = "0";
  await store.getShippingData();
  assert.equal(getCount, 1, "TTL=0 forces a fresh DB pull (bounds cross-instance staleness)");
  process.env.SHIPPING_CACHE_TTL_MS = "600000";
  // After a fresh pull the cache is warm again.
  resetCounters();
  await store.getShippingData();
  assert.equal(getCount, 0, "cache warm again after restoring TTL");
  ok("TTL: expiry forces a bounded fresh pull, then re-warms");

  console.log(`\naudit-rmw-cache-test: ${passed}/${passed} passed`);
  console.log("audit-rmw-cache-test-ok");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
