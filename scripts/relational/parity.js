// Parity gate (subphase 2a-5). Compares the blob projection vs the table
// projection at DATA level (canonical key-sorted JSON — key order is irrelevant
// because the normalizer spreads ...shippingLine). Both sides are run through
// normalizeShippingData (idempotent) so derived fields are rebuilt identically.
// Exits non-zero unless diff = 0. Also reports per-table row counts.
const { connectSandbox } = require("./sandbox-env");
const { readBlob, readAllTables, tableCounts, canonicalJson, canonicalize } = require("./repo");
const { assemble } = require("../../src/lib/db/relational-map");
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");
const { dropDanglingRefs } = require("./gates");

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

  // Apply the SAME migration normalization as migrate-forward (drop dangling
  // carrier↔yard refs) so parity compares the post-drop blob vs the tables.
  const blobProjection = normalizeShippingData(blob);
  dropDanglingRefs(blobProjection);
  const tableProjection = normalizeShippingData(assemble(tables));

  const A = canonicalJson(blobProjection);
  const B = canonicalJson(tableProjection);
  const equal = A === B;

  const counts = await tableCounts(pool, schema);
  console.log("[parity] table row counts:", JSON.stringify(counts));
  console.log(`[parity] DATA diff: ${equal ? "0 — PASS ✅" : "NONZERO — FAIL ❌"}`);

  if (!equal) {
    // Summarize ALL diffs by shape (so a dry-run sees the full scope, not just the first).
    const diffs = [];
    (function walk(a, b, p) {
      if (diffs.length > 200) return;
      const ta = Array.isArray(a) ? "arr" : a === null ? "null" : typeof a;
      const tb = Array.isArray(b) ? "arr" : b === null ? "null" : typeof b;
      if (ta !== tb) { diffs.push(`${p} [${ta} vs ${tb}]`); return; }
      if (ta === "arr") {
        if (a.length !== b.length) diffs.push(`${p} arr len ${a.length} vs ${b.length}`);
        for (let i = 0; i < Math.max(a.length, b.length); i += 1) walk(a[i], b[i], `${p}[${i}]`);
        return;
      }
      if (ta === "object") {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${p}.${k}`);
        return;
      }
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${p}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    })(canonicalize(blobProjection), canonicalize(tableProjection), "");
    const shapes = {};
    for (const d of diffs) {
      const key = d.replace(/\[\d+\]/g, "[]");
      shapes[key] = (shapes[key] || 0) + 1;
    }
    console.error(`[parity] ${diffs.length} canonical diffs. Shapes:`);
    for (const [k, v] of Object.entries(shapes)) console.error(`  (${v}) ${k.slice(0, 160)}`);
    await pool.end();
    process.exit(1);
  }
  await pool.end();
})().catch((e) => {
  console.error("[parity] FAILED:", e.message);
  process.exit(1);
});
