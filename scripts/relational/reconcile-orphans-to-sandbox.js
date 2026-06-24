// RECONCILE PREVIEW (sandbox only — NOT applied to prod). Loads the prod snapshot,
// drops dangling carrier↔yard links (customs line.yardIds → non-existent yards, and
// the symmetric yard.shippingLineIds → non-existent carriers), and writes the
// cleaned blob into the SANDBOX app_state so the toolchain can prove that, after
// this lossless cleanup, parity = 0. The actual prod cleanup is a separate,
// Chandler-approved scoped prod write; this only previews it in the sandbox.
const fs = require("node:fs");
const path = require("node:path");
const { connectSandbox } = require("./sandbox-env");
const repo = require("./repo");

const SNAP = path.join(__dirname, "../../.prod-blob-snapshot.json");

(async () => {
  const blob = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  const customs = blob.modules.customs;
  const yardIds = new Set((customs.yards || []).map((y) => y.id));
  const carrierIds = new Set((blob.modules.handover.shippingLines || []).map((l) => l.id));

  const removed = [];
  for (const line of customs.shippingLines || []) {
    for (const yid of line.yardIds || []) {
      if (!yardIds.has(yid)) removed.push({ line: line.id, deadYard: yid });
    }
    line.yardIds = (line.yardIds || []).filter((id) => yardIds.has(id));
  }
  for (const yard of customs.yards || []) {
    yard.shippingLineIds = (yard.shippingLineIds || []).filter((id) => carrierIds.has(id));
  }

  const { pool, ref, schema } = connectSandbox();
  const client = await pool.connect();
  try {
    await repo.ensureBaseTables(client, schema);
  } finally {
    client.release();
  }
  await repo.writeBlob(pool, schema, blob);
  console.log(`[reconcile-preview] ref=${ref} (SANDBOX) — dropped ${removed.length} dead carrier→yard links:`);
  console.log("  " + JSON.stringify(removed));
  console.log("[reconcile-preview] cleaned blob loaded into sandbox app_state (NOT prod)");
  await pool.end();
})().catch((e) => {
  console.error("[reconcile-preview]", e.message);
  process.exit(1);
});
