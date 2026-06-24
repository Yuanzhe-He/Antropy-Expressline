// PHASE 4 shadow — exercises the APP's store facade (src/lib/store) against PROD as the
// app role (postgres), reading in blob mode vs relational mode and confirming the ONLY
// delta is the known 8 dangling drops. This is the same code the deployed app runs in
// dual/relational, so it ALSO proves the app-as-postgres can run ensureRelationalSchema
// (the ALTER on migrator-owned tables) — if that errors here, fix ownership BEFORE dual.
//
// Read-only: only store.getShippingData() (no save path). HARD GATE: post-drop blob == relational
// AND dropped count == 8 (the shadow delta is exactly the known drops; any other delta = drift).
const { loadLocalEnv } = require("../../src/lib/env");
loadLocalEnv(); // prod .env -> DATABASE_URL (postgres, the app role)
process.env.STORAGE_DRIVER = "postgres";
process.env.SHIPPING_CACHE_TTL_MS = "0";

const { assertProd } = require("./prod-guard");
const ref = assertProd(process.env.DATABASE_URL); // refuse unless prod
const { dropDanglingRefs } = require("./gates");

(async () => {
  const store = require("../../src/lib/store");
  const db = require("../../src/lib/db");
  const repo = require("../../src/lib/store/relational-repo");
  const canon = repo.canonicalJson;
  console.log(`[phase4-shadow] ref=${ref} (PROD) via store facade as app role (postgres)`);

  // blob-mode read (raw, retains dangling refs)
  process.env.STORAGE_MODE = "blob";
  store.invalidateShippingDataCache();
  const blobRead = await store.getShippingData();

  // relational-mode read (app's relational read path: ensureRelationalSchema + assemble)
  process.env.STORAGE_MODE = "relational";
  store.invalidateShippingDataCache();
  const relRead = await store.getShippingData();

  // the shadow delta must be EXACTLY the known dangling drops
  const { dropped } = dropDanglingRefs(blobRead); // mutates blobRead → post-drop
  const equal = canon(blobRead) === canon(relRead);
  console.log(`[phase4-shadow] dropped ${dropped.length} dangling ref(s):`);
  for (const d of dropped) console.log(`    ${d.kind}: ${d.owner} → ${d.ref}`);
  console.log(`[phase4-shadow] post-drop blob(facade) == relational(facade): ${equal ? "YES ✅" : "NO ❌"}`);

  if (!equal) {
    // surface the residual drift (paths that still differ after the known drop)
    const a = repo.canonicalize(blobRead), b = repo.canonicalize(relRead);
    const diffs = [];
    (function walk(x, y, p) {
      if (diffs.length > 40) return;
      const tx = Array.isArray(x) ? "arr" : x === null ? "null" : typeof x;
      const ty = Array.isArray(y) ? "arr" : y === null ? "null" : typeof y;
      if (tx !== ty) { diffs.push(`${p} [${tx} vs ${ty}]`); return; }
      if (tx === "arr") { if (x.length !== y.length) diffs.push(`${p} len ${x.length} vs ${y.length}`); for (let i=0;i<Math.max(x.length,y.length);i++) walk(x[i],y[i],`${p}[${i}]`); return; }
      if (tx === "object") { for (const k of new Set([...Object.keys(x),...Object.keys(y)])) walk(x[k],y[k],`${p}.${k}`); return; }
      if (JSON.stringify(x)!==JSON.stringify(y)) diffs.push(`${p}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
    })(a, b, "");
    console.error(`[phase4-shadow] RESIDUAL DRIFT (${diffs.length}) beyond the known drops:`);
    diffs.slice(0,40).forEach(d => console.error("   ", d.slice(0,180)));
  }

  await db.closeDatabase();
  const gatePass = equal && dropped.length === 8;
  console.log(`\n[phase4-shadow] HARD GATE — shadow delta == exactly the 8 known drops: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
  if (!gatePass) process.exit(2);
})().catch((e) => {
  console.error("[phase4-shadow] ERROR:", e.message);
  process.exit(1);
});
