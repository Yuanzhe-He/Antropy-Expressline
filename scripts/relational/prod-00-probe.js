// PROD read-only probe — the gentlest first prod contact. Verifies admin connectivity,
// enumerates expressline tables + row counts/sizes (to design the backup), and lists the
// REAL public.joyas_*/punas_* table NAMES (names only — used as Phase 1 isolation-proof
// targets). HARD read-only transaction: no write can succeed. Touches NO joyas/punas DATA.
const { connectProdAdmin } = require("./prod-env");

(async () => {
  const { pool, ref, schema, role } = connectProdAdmin();
  console.log(`[prod-probe] ref=${ref} (PROD) schema=${schema} role=${role}`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set transaction read only"); // HARD read-only

    // expressline base tables + row counts
    const tbls = await client.query(
      `select table_name from information_schema.tables
         where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
      [schema]
    );
    console.log(`\n[expressline] ${tbls.rows.length} base tables:`);
    for (const { table_name } of tbls.rows) {
      const c = await client.query(`select count(*)::int n from ${schema}."${table_name}"`);
      console.log(`   ${table_name.padEnd(24)} rows=${c.rows[0].n}`);
    }

    // app_state keys + payload sizes (the migration source)
    const keys = await client.query(
      `select key, pg_column_size(payload) bytes, revision, updated_at
         from ${schema}.app_state order by key`
    );
    console.log(`\n[expressline.app_state] keys:`);
    for (const r of keys.rows) {
      console.log(`   key=${r.key} payloadBytes=${r.bytes} revision=${r.revision} updated_at=${r.updated_at?.toISOString?.() || r.updated_at}`);
    }

    // REAL joyas_*/punas_* table names (Phase 1 isolation-proof targets) — NAMES ONLY
    const others = await client.query(
      `select table_name from information_schema.tables
         where table_schema = 'public'
           and (table_name like 'joyas\\_%' or table_name like 'punas\\_%')
         order by table_name`
    );
    const joyas = others.rows.filter((r) => r.table_name.startsWith("joyas_")).map((r) => r.table_name);
    const punas = others.rows.filter((r) => r.table_name.startsWith("punas_")).map((r) => r.table_name);
    console.log(`\n[public other-businesses] joyas_*=${joyas.length} punas_*=${punas.length} (NAMES ONLY, no data read)`);
    console.log(`   joyas sample: ${joyas.slice(0, 4).join(", ")}`);
    console.log(`   punas sample: ${punas.slice(0, 4).join(", ")}`);

    await client.query("commit");
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`\n[prod-probe] OK — read-only, expressline-scoped (+ other-business table NAMES only).`);
})().catch((e) => {
  console.error("[prod-probe] ERROR:", e.message);
  process.exit(1);
});
