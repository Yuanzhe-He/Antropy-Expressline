// STEP 8 / PART 2 — prove the blob/dual seed guard FAILS LOUD on prod.
// After the cutover the relational tables are populated and the shipping-data blob is
// RETIRED. A tool (or a misconfig) that runs the store in blob/dual mode would previously
// re-seed a stray `shipping-data` (the post-retirement footgun). With the symmetric seed
// guard in src/lib/store/index.js, getShippingData must now THROW instead of seeding.
//
// This sets STORAGE_MODE=blob in THIS process ONLY — it never touches the live app's env
// (the deployed app stays STORAGE_MODE=relational). The guard throws BEFORE any write, so
// this is data-safe; we additionally re-inventory to prove no stray key was created.
//   node scripts/relational/prod-verify-seed-guard.js
const { loadLocalEnv } = require("../../src/lib/env");
loadLocalEnv();
process.env.STORAGE_DRIVER = "postgres";
process.env.SHIPPING_CACHE_TTL_MS = "0";
process.env.STORAGE_MODE = "blob"; // THIS PROCESS ONLY — not the live app
const { assertProd } = require("./prod-guard");
const { connectProdAdmin } = require("./prod-env");

const ref = assertProd(process.env.DATABASE_URL);

(async () => {
  const store = require("../../src/lib/store");
  const db = require("../../src/lib/db");
  console.log(`[verify-seed-guard] ref=${ref} (PROD) STORAGE_MODE=blob (this process only) — expecting the seed guard to THROW\n`);

  store.invalidateShippingDataCache();
  let threw = false;
  let msg = "";
  try {
    await store.getShippingData(); // blob retired + tables populated → MUST throw, not seed
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  await db.closeDatabase();
  console.log(`[verify-seed-guard] blob-mode getShippingData threw the guard: ${threw ? "YES ✅" : "NO ❌ (it SEEDED instead!)"}`);
  if (threw) console.log(`[verify-seed-guard]   message: ${msg}`);
  const guardMsg = /MISSING but the relational tables are NON-EMPTY/.test(msg);

  // Defense-in-depth: confirm the guard did NOT create a stray `shipping-data` key.
  const { pool, schema } = connectProdAdmin();
  const keys = (await pool.query(`select key from ${schema}.app_state order by key`)).rows.map((r) => r.key);
  await pool.end();
  const noStray = !keys.includes("shipping-data");
  console.log(`[verify-seed-guard] app_state keys now: ${keys.join(", ")}`);
  console.log(`[verify-seed-guard] no stray 'shipping-data' re-created: ${noStray ? "YES ✅" : "NO ❌"}`);

  const pass = threw && guardMsg && noStray;
  console.log(`\n[verify-seed-guard] HARD GATE — blob-mode seed guard fails loud + no stray re-seed: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  if (!pass) process.exit(2);
})().catch((e) => {
  console.error("[verify-seed-guard] ERROR:", e.message);
  process.exit(1);
});
