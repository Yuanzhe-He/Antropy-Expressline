// PHASE 3 — Forward migrate prod expressline.app_state[shipping-data] → the 18 entity
// tables, via the restricted migrator. SAME normalization as the sandbox-verified path:
//   Q5 currency (raw) → normalize → dropDanglingRefs (8 dead links, each logged) →
//   Q4 orphan (post-drop; ABORTS on any REMAINING orphan) → decompose → upsert.
//
// The live blob is actively written (FX storm), so we PIN it: read once, save the exact
// bytes locally (+sha), and migrate from the pinned copy. Phase 4 parity compares the
// tables against this SAME pinned blob (deterministic despite concurrent app writes).
// Reads app_state (SELECT-only) but NEVER writes it; writes only the migrator-owned tables.
//
// Run preview:  node prod-03-migrate-forward.js
// Execute:      node prod-03-migrate-forward.js --execute
//
// HARD GATE: Q5 PASS + Q4 post-drop PASS(0). Any non-dangling orphan or Q5 hit → STOP.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { connectProdMigrator } = require("./prod-env");
const { readBlob, upsertAllTables, tableCounts, canonicalJson } = require("../../src/lib/db/relational-repo");
const { currencyGate, orphanGate, dropDanglingRefs } = require("./gates");
const { decompose } = require("../../src/lib/db/relational-map");
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");

const PIN = path.join(__dirname, "../../backups/.prod-migration-pin.json");
const EXECUTE = process.argv.includes("--execute");

(async () => {
  const { pool, ref, schema, role } = connectProdMigrator();
  console.log(`[phase3] ref=${ref} (PROD) schema=${schema} role=${role}  mode=${EXECUTE ? "EXECUTE" : "PREVIEW"}`);

  // (0) read + PIN the live blob (exact bytes)
  const blob = await readBlob(pool, schema);
  if (!blob) {
    console.error("[phase3] no expressline.app_state[shipping-data] blob — STOP");
    await pool.end();
    process.exit(1);
  }
  const pinnedJson = JSON.stringify(blob);
  const pinSha = crypto.createHash("sha256").update(pinnedJson).digest("hex");
  fs.writeFileSync(PIN, JSON.stringify({ takenAt: new Date().toISOString(), ref, sha256: pinSha, blob }));
  console.log(`[phase3] pinned live blob: ${path.relative(path.join(__dirname, "../.."), PIN)} sha256=${pinSha.slice(0,16)}… bytes=${pinnedJson.length}`);
  console.log(`[phase3] source: carriers=${blob.modules?.handover?.shippingLines?.length} yards=${blob.modules?.customs?.yards?.length} dests=${blob.modules?.inland?.destinations?.length}`);

  // (1) Q5 currency on RAW blob
  const cur = currencyGate(blob);
  console.log(`[gates] Q5 currency (raw): ${cur.ok ? "PASS" : `FAIL (${cur.violations.length})`}`);
  if (!cur.ok) {
    console.error("[phase3] STOP: Q5 currency violations —", JSON.stringify(cur.violations.slice(0, 20)));
    await pool.end();
    process.exit(2);
  }

  // (2) normalize + DROP dangling carrier↔yard refs (each logged for audit)
  const normalized = normalizeShippingData(blob);
  const { dropped } = dropDanglingRefs(normalized);
  for (const d of dropped) console.log(`[reconcile] DROP ${d.kind}: ${d.owner} → ${d.ref} (target deleted, lossless)`);
  console.log(`[reconcile] dropped ${dropped.length} dangling carrier↔yard ref(s)`);

  // (3) Q4 orphan AFTER drop — any remaining orphan is a DIFFERENT class → ABORT
  const orph = orphanGate(normalized);
  console.log(`[gates] Q4 orphan (post-drop): ${orph.ok ? "PASS (0)" : `FAIL (${orph.orphans.length})`}`);
  if (!orph.ok) {
    console.error("[phase3] STOP: non-dangling orphan(s) remain after drop —", JSON.stringify(orph.orphans.slice(0, 20)));
    await pool.end();
    process.exit(2);
  }

  const tables = decompose(normalized);
  const plannedCounts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));

  if (!EXECUTE) {
    console.log(`[phase3] would upsert:`, JSON.stringify(plannedCounts));
    console.log(`[phase3] PREVIEW only — gates ran in-memory, NO write. Re-run with --execute to upsert.`);
    await pool.end();
    return;
  }

  // (4) upsert all tables in one transaction (writes only migrator-owned tables)
  const c = await pool.connect();
  try {
    await c.query("begin");
    const counts = await upsertAllTables(c, schema, tables);
    await c.query("commit");
    console.log("[phase3] upserted:", JSON.stringify(counts));
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }

  const counts = await tableCounts(pool, schema);
  console.log("[phase3] table row counts now:", JSON.stringify(counts));
  const gatePass = cur.ok && orph.ok;
  console.log(`\n[phase3] HARD GATE — Q5 PASS + Q4 post-drop PASS + ${dropped.length} logged drops: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`[phase3] app_state NOT written (blob remains source of truth). Pin sha256=${pinSha}`);
  await pool.end();
  if (!gatePass) process.exit(2);
})().catch((e) => {
  console.error("[phase3] ERROR:", e.message);
  process.exit(1);
});
