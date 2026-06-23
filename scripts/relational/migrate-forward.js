// Forward migration: app_state blob → relational tables (subphase 2a-2).
// Idempotent (upsert). Runs the Q4 orphan + Q5 currency gates on the blob FIRST
// and ABORTS on any hit (no silent coerce/drop). Does NOT touch app_state (blob
// stays the rollback source of truth).
const { connectSandbox } = require("./sandbox-env");
const { ensureBaseTables, readBlob, upsertAllTables, tableCounts } = require("./repo");
const { runGates } = require("./gates");
const { decompose } = require("../../src/lib/store/relational-map");

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

  // GATES — fail loud, do not migrate on a hit. --allow-gate-fail is a
  // SANDBOX-ONLY dry-run switch to continue past a gate and characterize the
  // full impact; the prod cutover NEVER uses it (it always hard-aborts here).
  const allowGateFail = process.argv.includes("--allow-gate-fail");
  if (!runGates(blob, "prod-blob")) {
    if (allowGateFail) {
      console.warn(
        "[migrate-forward] ⚠ DRY-RUN: a gate FAILED but --allow-gate-fail is set — " +
          "continuing in the SANDBOX to characterize impact. NEVER used for prod cutover."
      );
    } else {
      console.error("[migrate-forward] ABORT: a data gate failed — reconcile before migrating.");
      await pool.end();
      process.exit(2);
    }
  }

  const tables = decompose(blob);
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
