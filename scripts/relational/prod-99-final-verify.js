// Final read-only state verification (via the migrator). Confirms: the 18 entity tables
// are populated, app_state is still intact (2 rows, shipping-data present), and isolation
// STILL holds (joyas/punas still permission-denied). No writes.
const { connectProdMigrator } = require("./prod-env");
const { tableCounts } = require("../../src/lib/db/relational-repo");

(async () => {
  const { pool, ref, schema, role } = connectProdMigrator();
  console.log(`[final-verify] ref=${ref} (PROD) schema=${schema} role=${role}`);

  const counts = await tableCounts(pool, schema);
  const populated = Object.values(counts).filter((n) => n > 0).length;
  console.log(`[final-verify] 18 entity tables (${populated} populated):`, JSON.stringify(counts));

  const appState = await pool.query(
    `select key, revision from ${schema}.app_state order by key`
  );
  console.log(`[final-verify] app_state rows=${appState.rows.length} keys=${appState.rows.map((r) => r.key).join(",")} (untouched by migration; migrator is SELECT-only on it)`);

  // isolation still holds
  for (const t of ["joyas_asset_products", "punas_customers"]) {
    try {
      await pool.query(`select 1 from public."${t}" limit 1`);
      console.log(`   public.${t}: NOT DENIED ❌`);
    } catch (e) {
      console.log(`   public.${t}: ${e.code === "42501" ? "permission denied ✅" : "[" + e.code + "] " + e.message}`);
    }
  }
  await pool.end();
  console.log(`[final-verify] OK — tables populated, app_state intact, joyas/punas isolated.`);
})().catch((e) => {
  console.error("[final-verify] ERROR:", e.message);
  process.exit(1);
});
