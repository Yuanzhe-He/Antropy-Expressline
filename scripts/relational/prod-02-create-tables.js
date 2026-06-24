// PHASE 2 — Create the 18 relational tables in prod expressline, via the restricted
// migrator role. Uses the SAME sandbox-verified buildSchemaDDL (idempotent, all
// `create ... if not exists`). Does NOT touch app_state (the migrator has SELECT-only
// on it; and the DDL issues no app_state DML — the `create schema` statement is filtered
// out since the schema already exists and the migrator lacks create-database).
//
// Run preview:  node prod-02-create-tables.js
// Execute:      node prod-02-create-tables.js --execute
//
// HARD GATE: all 18 RELATIONAL_TABLES present (owned by the migrator) + app_state row
// count unchanged.
const { connectProdMigrator } = require("./prod-env");
const { buildSchemaDDL, RELATIONAL_TABLES } = require("../../src/lib/store/relational-repo");

const EXECUTE = process.argv.includes("--execute");

(async () => {
  const { pool, ref, schema, role } = connectProdMigrator();
  console.log(`[phase2] ref=${ref} (PROD) schema=${schema} role=${role}  mode=${EXECUTE ? "EXECUTE" : "PREVIEW"}`);

  // current state
  const before = await pool.query(
    `select table_name from information_schema.tables where table_schema=$1 and table_type='BASE TABLE' order by table_name`,
    [schema]
  );
  const beforeSet = new Set(before.rows.map((r) => r.table_name));
  const appStateBefore = (await pool.query(`select count(*)::int n from ${schema}.app_state`)).rows[0].n;
  const missing = RELATIONAL_TABLES.filter((t) => !beforeSet.has(t));
  console.log(`[phase2] existing tables: ${[...beforeSet].join(", ")}`);
  console.log(`[phase2] of the 18 relational tables, MISSING (would be created): ${missing.length ? missing.join(", ") : "(none — all present)"}`);
  console.log(`[phase2] app_state rows before: ${appStateBefore}`);

  // DDL minus the create-schema statement (schema already exists; migrator owns only schema objects)
  const stmts = buildSchemaDDL(schema).filter((s) => !/^\s*create schema /i.test(s));

  if (!EXECUTE) {
    console.log(`\n[phase2] would run ${stmts.length} DDL statements (create table/index/alter, all idempotent).`);
    console.log(`[phase2] PREVIEW only — no DDL run. Re-run with --execute to apply.`);
    await pool.end();
    return;
  }

  const c = await pool.connect();
  try {
    await c.query("begin");
    for (const s of stmts) await c.query(s);
    await c.query("commit");
    console.log(`[phase2] ran ${stmts.length} DDL statements (committed).`);
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }

  // verify: 18 tables present + owner + app_state untouched (count)
  const owners = await pool.query(
    `select tablename, tableowner from pg_tables where schemaname=$1 order by tablename`,
    [schema]
  );
  const ownerByTable = Object.fromEntries(owners.rows.map((r) => [r.tablename, r.tableowner]));
  const present = RELATIONAL_TABLES.filter((t) => t in ownerByTable);
  const stillMissing = RELATIONAL_TABLES.filter((t) => !(t in ownerByTable));
  const allMigratorOwned = present.every((t) => ownerByTable[t] === role);
  const appStateAfter = (await pool.query(`select count(*)::int n from ${schema}.app_state`)).rows[0].n;

  console.log(`[phase2] relational tables present: ${present.length}/18  (owner=${role} for all: ${allMigratorOwned})`);
  if (stillMissing.length) console.log(`[phase2] STILL MISSING: ${stillMissing.join(", ")}`);
  console.log(`[phase2] app_state rows after: ${appStateAfter} (before ${appStateBefore}) — unchanged: ${appStateAfter === appStateBefore}`);
  console.log(`[phase2] (app_state content is privilege-protected: migrator has SELECT-only, issued no app_state DML)`);

  const gatePass = present.length === 18 && stillMissing.length === 0 && appStateAfter === appStateBefore;
  console.log(`\n[phase2] HARD GATE — all 18 tables present + app_state untouched: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
  await pool.end();
  if (!gatePass) process.exit(2);
})().catch((e) => {
  console.error("[phase2] ERROR:", e.message);
  process.exit(1);
});
