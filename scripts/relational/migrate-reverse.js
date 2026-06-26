// Reverse migration: relational tables → blob (subphase 2a-3 / rollback §C.2).
// Reads all tables, assembles + normalizes back to the shipping-data shape, and
// verifies reverse(forward(blob)) == normalize(blob) (canonical). Writes the
// reconstructed blob to a separate key by default (--apply writes the real
// shipping-data key, the rollback action). Never drops the source blob.
const { connectSandbox } = require("./sandbox-env");
const { readBlob, readAllTables, writeBlob, canonicalJson } = require("./repo");
const { assemble } = require("../../src/lib/db/relational-map");
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");
const { dropDanglingRefs } = require("./gates");

(async () => {
  const apply = process.argv.includes("--apply");
  const targetKey = apply ? "shipping-data" : "shipping-data-rollback";
  const { pool, ref, schema } = connectSandbox();
  console.log(`[migrate-reverse] ref=${ref} schema=${schema} → key=${targetKey}${apply ? " (--apply)" : " (verify-only)"}`);

  const tables = await readAllTables(pool, schema);
  const reconstructed = normalizeShippingData(assemble(tables));

  // verify against the current source blob, if present
  const sourceBlob = await readBlob(pool, schema);
  if (sourceBlob) {
    // Compare against the post-drop blob (same migration normalization as forward).
    const baseline = normalizeShippingData(sourceBlob);
    dropDanglingRefs(baseline);
    const equal = canonicalJson(baseline) === canonicalJson(reconstructed);
    console.log(`[migrate-reverse] reverse(forward(blob)) == normalize(blob): ${equal ? "YES ✅" : "NO ❌"}`);
    if (!equal) {
      await pool.end();
      process.exit(1);
    }
  } else {
    console.log("[migrate-reverse] (no source blob to compare; writing reconstructed blob)");
  }

  await writeBlob(pool, schema, reconstructed, targetKey);
  console.log(
    `[migrate-reverse] wrote reconstructed blob to app_state.${targetKey}` +
      ` (carriers=${reconstructed.modules.handover.shippingLines.length})`
  );
  await pool.end();
})().catch((e) => {
  console.error("[migrate-reverse] FAILED:", e.message);
  process.exit(1);
});
