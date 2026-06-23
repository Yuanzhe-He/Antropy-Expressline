// Parity gate (subphase 2a-5). Compares the blob projection vs the table
// projection at DATA level (canonical key-sorted JSON — key order is irrelevant
// because the normalizer spreads ...shippingLine). Both sides are run through
// normalizeShippingData (idempotent) so derived fields are rebuilt identically.
// Exits non-zero unless diff = 0. Also reports per-table row counts.
const { connectSandbox } = require("./sandbox-env");
const { readBlob, readAllTables, tableCounts, canonicalJson, canonicalize } = require("./repo");
const { assemble } = require("../../src/lib/store/relational-map");
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");

// Walk two canonicalized values and report the first differing path.
function firstDiff(a, b, path = "") {
  if (a === b) {
    return null;
  }
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb) {
    return { path, blob: a, table: b, reason: `type ${ta} vs ${tb}` };
  }
  if (ta === "array") {
    if (a.length !== b.length) {
      return { path, reason: `array length ${a.length} vs ${b.length}` };
    }
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (ta === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return { path, blob: a, table: b };
}

(async () => {
  const { pool, ref, schema } = connectSandbox();
  console.log(`[parity] ref=${ref} schema=${schema}`);

  const blob = await readBlob(pool, schema);
  if (!blob) {
    console.error("[parity] no app_state blob — nothing to compare");
    await pool.end();
    process.exit(1);
  }
  const tables = await readAllTables(pool, schema);

  const blobProjection = normalizeShippingData(blob);
  const tableProjection = normalizeShippingData(assemble(tables));

  const A = canonicalJson(blobProjection);
  const B = canonicalJson(tableProjection);
  const equal = A === B;

  const counts = await tableCounts(pool, schema);
  console.log("[parity] table row counts:", JSON.stringify(counts));
  console.log(`[parity] DATA diff: ${equal ? "0 — PASS ✅" : "NONZERO — FAIL ❌"}`);

  if (!equal) {
    const d = firstDiff(canonicalize(blobProjection), canonicalize(tableProjection));
    console.error("[parity] first diff:", JSON.stringify(d).slice(0, 600));
    await pool.end();
    process.exit(1);
  }
  await pool.end();
})().catch((e) => {
  console.error("[parity] FAILED:", e.message);
  process.exit(1);
});
