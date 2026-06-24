// Forward migration: app_state blob → relational tables (subphase 2a-2).
// Idempotent (upsert). Migration normalization: Q5 currency gate (raw) → DROP
// dangling carrier↔yard refs (target deleted = lossless, logged) → Q4 orphan gate
// (post-drop; ABORTS on any REMAINING orphan, never silently swallowed). Does NOT
// touch app_state (blob stays the rollback source of truth). The prod cutover runs
// this SAME script on the prod blob.
const { connectSandbox } = require("./sandbox-env");
const { ensureBaseTables, readBlob, upsertAllTables, tableCounts } = require("./repo");
const { currencyGate, orphanGate, dropDanglingRefs } = require("./gates");
const { decompose } = require("../../src/lib/store/relational-map");
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");

(async () => {
  const { pool, ref, schema } = connectSandbox();
  console.log(`[migrate-forward] ref=${ref} schema=${schema}`);

  const client = await pool.connect();
  try {
    await ensureBaseTables(client, schema);
  } finally {
    client.release();
  }

  const blob = await readBlob(pool, schema);
  if (!blob) {
    console.error("[migrate-forward] no app_state.shipping-data blob to migrate (seed first)");
    await pool.end();
    process.exit(1);
  }

  // (1) Q5 currency gate on the RAW blob — must scan before normalize coerces.
  const cur = currencyGate(blob);
  console.log(`[gates] Q5 currency: ${cur.ok ? "PASS" : `FAIL (${cur.violations.length})`}`);
  if (!cur.ok) {
    console.error("[migrate-forward] ABORT: Q5 currency violations —", JSON.stringify(cur.violations.slice(0, 20)));
    await pool.end();
    process.exit(2);
  }

  // (2) Migration normalization + DROP dangling carrier↔yard refs (target deleted
  // = lossless). Loud, auditable per-ref log.
  const normalized = normalizeShippingData(blob);
  const { dropped } = dropDanglingRefs(normalized);
  for (const d of dropped) {
    console.log(`[reconcile] DROP ${d.kind}: ${d.owner} → ${d.ref} (target deleted, lossless)`);
  }
  console.log(`[reconcile] dropped ${dropped.length} dangling carrier↔yard ref(s)`);

  // (3) Q4 orphan gate AFTER the drop. The dangling-to-deleted class is resolved;
  // ANY remaining orphan is a DIFFERENT class (target exists, mis-bucketed) →
  // ABORT, never silently swallowed.
  const orph = orphanGate(normalized);
  console.log(`[gates] Q4 orphan (post-drop): ${orph.ok ? "PASS" : `FAIL (${orph.orphans.length})`}`);
  if (!orph.ok) {
    console.error("[migrate-forward] ABORT: non-dangling orphan(s) remain after drop —", JSON.stringify(orph.orphans.slice(0, 20)));
    await pool.end();
    process.exit(2);
  }

  const tables = decompose(normalized);
  const txn = await pool.connect();
  try {
    await txn.query("begin");
    const counts = await upsertAllTables(txn, schema, tables);
    await txn.query("commit");
    console.log("[migrate-forward] upserted:", JSON.stringify(counts));
  } catch (e) {
    await txn.query("rollback");
    throw e;
  } finally {
    txn.release();
  }

  const counts = await tableCounts(pool, schema);
  console.log("[migrate-forward] table row counts now:", JSON.stringify(counts));
  console.log("[migrate-forward] OK — blob preserved in app_state (rollback source)");
  await pool.end();
})().catch((e) => {
  console.error("[migrate-forward] FAILED:", e.message);
  process.exit(1);
});
