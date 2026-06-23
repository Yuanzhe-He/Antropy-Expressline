// Relational/dual integration test (subphase 2a-6). Drives the REAL store facade
// (src/lib/store) against the sandbox in blob / relational / dual modes and
// asserts behavior parity. Project-isolation hard-asserted before any DB use.
//
// Env is loaded from .env.sandbox FIRST (so DATABASE_URL=sandbox) then the store
// is required (db.js loadLocalEnv only fills UNSET vars, so it can't override).
const fs = require("node:fs");
const path = require("node:path");

// 1) load sandbox env before anything touches the DB
for (const line of fs.readFileSync(path.join(__dirname, "../../.env.sandbox"), "utf8").split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0) {
    const k = line.slice(0, i).trim();
    if (k) process.env[k] = line.slice(i + 1).trim();
  }
}
process.env.STORAGE_DRIVER = "postgres";
process.env.SHIPPING_CACHE_TTL_MS = "0"; // never serve a stale cache across mode flips

const { assertSandbox } = require("../sandbox-guard");
const ref = assertSandbox(); // HARD STOP unless DATABASE_URL == sandbox

const { connectSandbox } = require("./sandbox-env");
const repo = require("../../src/lib/store/relational-repo");
const { decompose } = require("../../src/lib/store/relational-map");
const { buildSchemaDDL, buildDropDDL } = repo;
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");

let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log("  PASS ", m);
};
const assert = (cond, m) => {
  if (!cond) {
    throw new Error("FAIL: " + m);
  }
  ok(m);
};

(async () => {
  const { pool: setupPool, schema } = connectSandbox();

  // --- setup: reset schema, seed app_state blob, forward-migrate to tables ---
  const seed = normalizeShippingData(
    JSON.parse(fs.readFileSync(path.join(__dirname, "../../data/shipping-lines.json"), "utf8"))
  );
  const client = await setupPool.connect();
  try {
    await client.query("begin");
    for (const s of buildDropDDL(schema)) await client.query(s);
    for (const s of buildSchemaDDL(schema)) await client.query(s);
    await repo.ensureBaseTables(client, schema);
    await client.query("commit");
  } finally {
    client.release();
  }
  await repo.writeBlob(setupPool, schema, seed);
  const txn = await setupPool.connect();
  try {
    await txn.query("begin");
    await repo.upsertAllTables(txn, schema, decompose(seed));
    await txn.query("commit");
  } finally {
    txn.release();
  }
  await setupPool.end();

  // --- now exercise the real store facade (its own db.js pool) ----------------
  const store = require("../../src/lib/store");
  const db = require("../../src/lib/db");
  const canon = repo.canonicalJson;

  // (1) read parity: blob mode vs relational mode (same underlying seed data)
  process.env.STORAGE_MODE = "blob";
  store.invalidateShippingDataCache();
  const blobRead = await store.getShippingData();
  process.env.STORAGE_MODE = "relational";
  store.invalidateShippingDataCache();
  const relRead = await store.getShippingData();
  assert(canon(blobRead) === canon(relRead), "getShippingData blob == relational (data parity)");
  assert(canon(relRead) === canon(seed), "relational read == seed projection");

  // (2) relational save round-trip on an ISOLATED field (a yard note — no derived
  // propagation): save → read → exactly equals normalize(edit), nothing else moves.
  process.env.STORAGE_MODE = "relational";
  const edit = await store.getShippingData();
  edit.modules.customs.yards[0].note = "RELATIONAL ROUNDTRIP NOTE";
  await store.saveShippingData(edit);
  store.invalidateShippingDataCache();
  const afterSave = await store.getShippingData();
  assert(
    afterSave.modules.customs.yards[0].note === "RELATIONAL ROUNDTRIP NOTE",
    "relational saveShippingData persisted the yard note"
  );
  assert(
    canon(afterSave) === canon(normalizeShippingData(edit)),
    "relational save+read round-trips the edit exactly (no spurious changes)"
  );
  // restore
  edit.modules.customs.yards[0].note = seed.modules.customs.yards[0].note;
  await store.saveShippingData(edit);

  // (3) dual mode: shadow read reports tables == blob (clean)
  process.env.STORAGE_MODE = "dual";
  store.invalidateShippingDataCache();
  await store.getShippingData();
  const diff = store.getLastShadowDiff();
  assert(diff && diff.equal === true, "dual shadow read: table projection == blob projection");

  // (4) relational FX write touches ONLY exchange_rates
  process.env.STORAGE_MODE = "relational";
  store.invalidateShippingDataCache();
  const cur = await store.getShippingData();
  const fx = structuredClone(cur);
  fx.exchangeRates.pairs = [{ base: "USD", quote: "MXN", rate: 99.99 }];
  await store.saveExchangeRates(fx);
  store.invalidateShippingDataCache();
  const afterFx = await store.getShippingData();
  assert(
    afterFx.exchangeRates.pairs[0].rate === 99.99,
    "relational saveExchangeRates updated the rate"
  );
  assert(
    canon({ ...afterFx, exchangeRates: null }) === canon({ ...cur, exchangeRates: null }),
    "relational FX write left all non-FX data unchanged"
  );

  await db.closeDatabase();
  console.log(`\n[integration-test] ref=${ref} — ${passed} assertions PASS ✅`);
})().catch((e) => {
  console.error("[integration-test]", e.message);
  process.exit(1);
});
