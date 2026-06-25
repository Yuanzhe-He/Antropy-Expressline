// Verifies the BLOB/DUAL read AUTO-SEED GUARD (src/lib/store/index.js) — the symmetric
// counterpart to the relational seed guard. When STORAGE_MODE=blob|dual and the
// app_state.shipping-data blob is MISSING, getShippingData seeds demo data ONLY when the
// relational tables are ALSO empty. If the tables are NON-empty, the blob was retired/
// migrated (cutover Step 8), NOT a fresh store, so getShippingData REFUSES to seed (which
// would silently overwrite the live store AND resurrect the retired key — the
// post-retirement re-seed footgun) and throws a clear error. Mocks the db layer (no Postgres).
const assert = require("node:assert/strict");
const path = require("node:path");

let tablesAssembled = null; // null = empty tables
let blobPayload = null; // null = missing/empty blob
let appStateWrites = 0; // saveAppState (blob seed) calls
let tableSeedWrites = 0; // saveShippingTables (table seed) calls

const fakeDb = {
  shouldUseDatabase: () => true,
  getDatabaseSchema: () => "expressline",
  getShippingTablesAssembled: async () => (tablesAssembled ? structuredClone(tablesAssembled) : null),
  getAppState: async (key) => (key === "shipping-data" && blobPayload ? structuredClone(blobPayload) : null),
  saveShippingTables: async () => {
    tableSeedWrites += 1;
  },
  saveAppState: async () => {
    appStateWrites += 1;
  },
  patchAppStateField: async () => 1,
  saveCarrierEntity: async () => {},
  saveCustomsYardEntity: async () => {},
  saveExchangeRatesTable: async () => {},
  saveInlandRateEntryEntity: async () => {},
  saveModuleTables: async () => {},
};

const dbPath = require.resolve(path.join(__dirname, "../src/lib/db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

process.env.SHIPPING_CACHE_TTL_MS = "0"; // never serve a stale cache across cases
const store = require("../src/lib/store");

const NON_EMPTY_TABLES = {
  modules: { handover: { shippingLines: [{ id: "from-tables", name: "From Tables" }] } },
};
const PRESENT_BLOB = {
  modules: { handover: { shippingLines: [{ id: "from-blob", name: "From Blob" }] } },
};
const GUARD_RE = /MISSING but the relational tables are NON-EMPTY/;

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};

async function main() {
  // Case A: blob mode + MISSING blob + NON-empty tables → REFUSE to seed; throw.
  process.env.STORAGE_MODE = "blob";
  tablesAssembled = NON_EMPTY_TABLES;
  blobPayload = null;
  appStateWrites = 0;
  tableSeedWrites = 0;
  store.invalidateShippingDataCache();
  await assert.rejects(
    () => store.getShippingData(),
    GUARD_RE,
    "blob mode + missing blob + non-empty tables must throw (no re-seed over a retired/migrated store)"
  );
  assert.equal(appStateWrites, 0, "must NOT write an app_state seed when tables are non-empty");
  assert.equal(tableSeedWrites, 0, "must NOT write a table seed either");
  ok("blob + missing blob + NON-empty tables → refuses to seed, throws (0 writes)");

  // Case B: dual mode shares the identical guard.
  process.env.STORAGE_MODE = "dual";
  tablesAssembled = NON_EMPTY_TABLES;
  blobPayload = null;
  appStateWrites = 0;
  tableSeedWrites = 0;
  store.invalidateShippingDataCache();
  await assert.rejects(() => store.getShippingData(), GUARD_RE, "dual mode shares the seed guard");
  assert.equal(appStateWrites + tableSeedWrites, 0, "dual must not seed over non-empty tables");
  ok("dual + missing blob + NON-empty tables → refuses to seed, throws (0 writes)");

  // Case C: blob mode + MISSING blob + EMPTY tables → genuinely fresh → seed exactly once.
  process.env.STORAGE_MODE = "blob";
  tablesAssembled = null;
  blobPayload = null;
  appStateWrites = 0;
  tableSeedWrites = 0;
  store.invalidateShippingDataCache();
  const fresh = await store.getShippingData();
  assert.ok(fresh && fresh.modules, "fresh store seeded a usable shape");
  assert.equal(appStateWrites, 1, "fresh store (blob AND tables empty) seeds app_state exactly once");
  ok("blob + missing blob + empty tables → seeds the fresh store (1 app_state write)");

  // Case D: blob mode + PRESENT blob → normal blob read, no seed, no throw.
  process.env.STORAGE_MODE = "blob";
  tablesAssembled = null;
  blobPayload = PRESENT_BLOB;
  appStateWrites = 0;
  tableSeedWrites = 0;
  store.invalidateShippingDataCache();
  const read = await store.getShippingData();
  assert.ok(read && read.modules && read.modules.handover, "blob read returned data");
  assert.equal(appStateWrites, 0, "a present blob never seeds");
  ok("blob + present blob → normal read, no seed");

  console.log(`\n[audit-blob-seed-guard] ${passed} assertions PASS ✅`);
}

main().catch((e) => {
  console.error("[audit-blob-seed-guard] FAIL:", e.message);
  process.exit(1);
});
