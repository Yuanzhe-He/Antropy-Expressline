// PHASE 4 prerequisite — transfer ownership of the 18 entity tables from
// expressline_migrator → postgres (the app role). REQUIRED because the app, on its
// first relational op, runs ensureRelationalSchema (CREATE INDEX / ALTER TABLE IF NOT
// EXISTS), which are OWNER-ONLY — as a non-owner the app errors "must be owner of table
// carriers". Transferring ownership to postgres (the long-term primary user) is the
// correct end-state. The migrator is re-granted CRUD so its build/re-align scripts keep
// working. DB-only, reversible, zero data touched.
//
// Run preview:  node prod-fix-ownership.js
// Execute:      node prod-fix-ownership.js --execute
//
// HARD GATE: all 18 tables owned by postgres + app-as-postgres can run buildSchemaDDL no-op.
const { connectProdAdmin } = require("./prod-env");
const { RELATIONAL_TABLES, buildSchemaDDL } = require("../../src/lib/store/relational-repo");

const MIGRATOR = "expressline_migrator";
const APP = "postgres";
const EXECUTE = process.argv.includes("--execute");

(async () => {
  const { pool, ref, schema } = connectProdAdmin();
  console.log(`[fix-owner] ref=${ref} (PROD) schema=${schema} as=${APP}  mode=${EXECUTE ? "EXECUTE" : "PREVIEW"}`);

  const ownersBefore = await pool.query(
    `select tablename, tableowner from pg_tables where schemaname=$1 and tablename = any($2) order by tablename`,
    [schema, RELATIONAL_TABLES]
  );
  const migOwned = ownersBefore.rows.filter((r) => r.tableowner === MIGRATOR).map((r) => r.tablename);
  console.log(`[fix-owner] tables owned by ${MIGRATOR} now: ${migOwned.length}/18`);

  if (!EXECUTE) {
    console.log(`[fix-owner] would: grant ${MIGRATOR} to ${APP} (enables transfer) → alter table <t> owner to ${APP} ×18 → re-grant ${MIGRATOR} CRUD.`);
    console.log(`[fix-owner] PREVIEW only.`);
    await pool.end();
    return;
  }

  const c = await pool.connect();
  try {
    await c.query("begin");
    // membership so postgres (a member of the current owner) may transfer ownership
    await c.query(`grant ${MIGRATOR} to ${APP}`);
    for (const t of RELATIONAL_TABLES) {
      await c.query(`alter table ${schema}."${t}" owner to ${APP}`);
      // keep the migrator able to read/write for re-align/parity scripts
      await c.query(`grant select, insert, update, delete on ${schema}."${t}" to ${MIGRATOR}`);
    }
    await c.query("commit");
    console.log(`[fix-owner] transferred 18 tables to ${APP} + re-granted ${MIGRATOR} CRUD (committed).`);
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }

  // verify ownership
  const ownersAfter = await pool.query(
    `select tablename, tableowner from pg_tables where schemaname=$1 and tablename = any($2) order by tablename`,
    [schema, RELATIONAL_TABLES]
  );
  const appOwned = ownersAfter.rows.filter((r) => r.tableowner === APP).map((r) => r.tablename);
  console.log(`[fix-owner] tables now owned by ${APP}: ${appOwned.length}/18`);

  // prove app-as-postgres can now run ensureRelationalSchema (buildSchemaDDL) as a no-op
  let ddlOk = true, ddlErr = "";
  const t2 = await pool.connect();
  try {
    await t2.query("begin");
    for (const s of buildSchemaDDL(schema)) await t2.query(s);
    await t2.query("rollback");
  } catch (e) {
    ddlOk = false; ddlErr = `[${e.code}] ${e.message}`;
    try { await t2.query("rollback"); } catch {}
  } finally {
    t2.release();
  }
  console.log(`[fix-owner] app-as-${APP} can run buildSchemaDDL (no-op, rolled back): ${ddlOk ? "YES ✅" : "NO ❌ " + ddlErr}`);

  const gatePass = appOwned.length === 18 && ddlOk;
  console.log(`\n[fix-owner] HARD GATE — 18 tables owned by ${APP} + ensureRelationalSchema runs clean: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
  await pool.end();
  if (!gatePass) process.exit(2);
})().catch((e) => {
  console.error("[fix-owner] ERROR:", e.message);
  process.exit(1);
});
