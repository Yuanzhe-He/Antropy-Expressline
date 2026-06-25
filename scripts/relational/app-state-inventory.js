// STEP 8 / PART A — read-only inventory of expressline.app_state keys.
// Lists every key with payload size, revision, and timestamps so we can confirm
// which keys are live vs orphaned BEFORE retiring the frozen shipping-data blob.
//
// HARD read-only transaction (set transaction read only) — no write can succeed.
// expressline-scoped ONLY: touches NOTHING in public/joyas_*/punas_*. Admin creds
// (the cutover blob → relational, Step 8). Run: node scripts/relational/app-state-inventory.js
const { connectProdAdmin } = require("./prod-env");

(async () => {
  const { pool, ref, schema, role } = connectProdAdmin();
  console.log(`[app-state-inventory] ref=${ref} (PROD) schema=${schema} role=${role} mode=READ-ONLY\n`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set transaction read only"); // HARD read-only

    const keys = await client.query(
      `select key,
              pg_column_size(payload)                  as stored_bytes,
              length(payload::text)                    as json_chars,
              revision,
              created_at,
              updated_at
         from ${schema}.app_state
        order by key`
    );
    console.log(`[expressline.app_state] ${keys.rows.length} key(s):`);
    for (const r of keys.rows) {
      console.log(
        `   key=${String(r.key).padEnd(28)} storedBytes=${String(r.stored_bytes).padStart(9)} ` +
          `jsonChars=${String(r.json_chars).padStart(9)} revision=${String(r.revision).padStart(8)} ` +
          `updated_at=${r.updated_at?.toISOString?.() || r.updated_at}`
      );
    }

    await client.query("commit");
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`\n[app-state-inventory] OK — read-only, expressline.app_state only.`);
})().catch((e) => {
  console.error("[app-state-inventory] ERROR:", e.message);
  process.exit(1);
});
