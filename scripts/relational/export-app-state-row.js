// STEP 8 / PART B — full pre-retirement archive of the expressline.app_state
// shipping-data row (key + complete payload + metadata) to a gitignored backup
// with a sha256, so the reversible rename has a write-before snapshot in addition
// to the Phase-0 raw backup (double anchor).
//
// HARD read-only transaction. expressline-scoped ONLY (never touches public/joyas/punas).
// Admin creds. Run: node scripts/relational/export-app-state-row.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { connectProdAdmin } = require("./prod-env");
const { canonicalJson } = require("../../src/lib/store/relational-repo");

const KEY = "shipping-data";
const OUT = path.join(__dirname, "../../backups/app_state-shipping-data-retired-20260625.json");

(async () => {
  const { pool, ref, schema, role } = connectProdAdmin();
  console.log(`[export-row] ref=${ref} (PROD) schema=${schema} role=${role} mode=READ-ONLY key=${KEY}\n`);
  const client = await pool.connect();
  let row;
  try {
    await client.query("begin");
    await client.query("set transaction read only"); // HARD read-only
    const r = await client.query(
      `select key, payload, revision, created_at, updated_at,
              pg_column_size(payload) as stored_bytes
         from ${schema}.app_state where key = $1`,
      [KEY]
    );
    row = r.rows[0];
    await client.query("commit");
  } finally {
    client.release();
    await pool.end();
  }

  if (!row) {
    console.error(`[export-row] ERROR: key ${KEY} not found in ${schema}.app_state — nothing to archive.`);
    process.exit(2);
  }

  const payloadCanonical = canonicalJson(row.payload);
  const payloadSha = crypto.createHash("sha256").update(payloadCanonical).digest("hex");

  const archive = {
    _meta: {
      purpose: "STEP 8 reversible-retirement archive of expressline.app_state shipping-data (frozen blob)",
      ref,
      schema,
      key: row.key,
      revision: row.revision,
      created_at: row.created_at,
      updated_at: row.updated_at,
      stored_bytes: row.stored_bytes,
      exported_at: new Date().toISOString(),
      payload_sha256_canonical: payloadSha,
    },
    key: row.key,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
    payload: row.payload,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(archive, null, 2), "utf8");
  const fileSha = crypto.createHash("sha256").update(fs.readFileSync(OUT)).digest("hex");

  console.log(`[export-row] wrote ${OUT}`);
  console.log(`[export-row]   key=${row.key} revision=${row.revision} storedBytes=${row.stored_bytes}`);
  console.log(`[export-row]   updated_at=${row.updated_at?.toISOString?.() || row.updated_at}`);
  console.log(`[export-row]   payload_sha256 (canonical) = ${payloadSha}`);
  console.log(`[export-row]   file_sha256                = ${fileSha}`);
})().catch((e) => {
  console.error("[export-row] ERROR:", e.message);
  process.exit(1);
});
