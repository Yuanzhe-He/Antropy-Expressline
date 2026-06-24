// Seed the sandbox app_state with the normalized seed blob, so the forward
// migration (and parity) has a representative source. Local-only test fixture —
// prod data is never copied here (cutover migrates prod's own blob in place).
const fs = require("node:fs");
const path = require("node:path");
const { connectSandbox } = require("./sandbox-env");
const { ensureBaseTables, writeBlob, readBlob } = require("./repo");
// require the normalizer directly (avoids src/lib/store/index.js loading prod .env)
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");

(async () => {
  const { pool, ref, schema } = connectSandbox();
  const seedPath = path.join(__dirname, "../../data/shipping-lines.json");
  const raw = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const blob = normalizeShippingData(raw);

  const client = await pool.connect();
  try {
    await ensureBaseTables(client, schema);
  } finally {
    client.release();
  }
  await writeBlob(pool, schema, blob);

  const back = await readBlob(pool, schema);
  console.log(
    `[seed-sandbox] ref=${ref} schema=${schema} — app_state.shipping-data written` +
      ` (carriers=${back.modules.handover.shippingLines.length},` +
      ` dests=${back.modules.inland.destinations.length})`
  );
  await pool.end();
})().catch((e) => {
  console.error("[seed-sandbox] FAILED:", e.message);
  process.exit(1);
});
