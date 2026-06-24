// Verifies the relational read AUTO-SEED GUARD (src/lib/store/index.js): an empty
// relational store is seeded with demo data ONLY when the app_state blob is ALSO empty.
// If the tables are empty but the blob is NON-empty (data loss / incomplete migration),
// getShippingData REFUSES to seed (which would silently overwrite the recoverable blob
// with demo data) and throws a clear error. Mocks the db layer (no real Postgres).
const assert = require("node:assert/strict");
const path = require("node:path");

let tablesAssembled = null; // null = empty tables
let blobPayload = null; // null = empty blob
let seedWrites = 0;

const fakeDb = {
  shouldUseDatabase: () => true,
  getDatabaseSchema: () => "expressline",
  getShippingTablesAssembled: async () => (tablesAssembled ? structuredClone(tablesAssembled) : null),
  getAppState: async (key) => (key === "shipping-data" && blobPayload ? structuredClone(blobPayload) : null),
  saveShippingTables: async () => {
    seedWrites += 1;
  },
  saveAppState: async () => {},
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
process.env.STORAGE_MODE = "relational";
const store = require("../src/lib/store");

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};

async function main() {
  // Case A: empty tables + NON-empty blob → REFUSE to seed; throw a clear data-loss error.
  tablesAssembled = null;
  blobPayload = { modules: { handover: { shippingLines: [{ id: "real-carrier", name: "Real" }] } } };
  seedWrites = 0;
  store.invalidateShippingDataCache();
  await assert.rejects(
    () => store.getShippingData(),
    /tables are EMPTY but app_state\.shipping-data is NON-EMPTY/,
    "empty tables + non-empty blob must throw (no silent demo seed over real data)"
  );
  assert.equal(seedWrites, 0, "must NOT write a demo seed when the blob is non-empty");
  ok("empty tables + NON-empty blob → refuses to seed, throws data-loss error (0 seed writes)");

  // Case B: empty tables + empty blob → genuinely fresh store → seed exactly once.
  tablesAssembled = null;
  blobPayload = null;
  seedWrites = 0;
  store.invalidateShippingDataCache();
  const fresh = await store.getShippingData();
  assert.ok(fresh && fresh.modules, "fresh store seeded a usable shape");
  assert.equal(seedWrites, 1, "fresh store (tables AND blob empty) seeds exactly once");
  ok("empty tables + empty blob → seeds the fresh store (1 seed write)");

  // Case C: non-empty tables → normal relational read, no seed, no throw.
  tablesAssembled = { modules: { handover: { shippingLines: [{ id: "from-tables", name: "From Tables" }] } } };
  blobPayload = null;
  seedWrites = 0;
  store.invalidateShippingDataCache();
  const read = await store.getShippingData();
  assert.ok(read && read.modules && read.modules.handover, "relational read returned data");
  assert.equal(seedWrites, 0, "non-empty tables never seed");
  ok("non-empty tables → relational read, no seed");

  console.log(`\n[audit-relational-seed-guard] ${passed} assertions PASS ✅`);
}

main().catch((e) => {
  console.error("[audit-relational-seed-guard] FAIL:", e.message);
  process.exit(1);
});
