// PHASE 1 (cutover Phase A) — grant the APP role (postgres, what Railway connects as)
// full CRUD on the 18 entity tables, which are owned by expressline_migrator. The GRANTs
// are run BY the migrator (the owner); the proof runs AS postgres (connectProdAdmin).
// DB-only, reversible (revoke), zero downtime — the app is still on blob.
//
// Run preview:  node prod-A-grant-app-role.js
// Execute:      node prod-A-grant-app-role.js --execute
//
// HARD GATE: as postgres, for EVERY table, an in-txn select+insert+update+delete (all
// no-op via WHERE false / SELECT…WHERE false, then ROLLBACK) succeeds. Any denial → STOP.
const { connectProdMigrator, connectProdAdmin } = require("./prod-env");
const { RELATIONAL_TABLES } = require("../../src/lib/store/relational-repo");
const { TABLE_META } = require("../../src/lib/store/relational-map");

const APP_ROLE = "postgres";
const EXECUTE = process.argv.includes("--execute");

(async () => {
  // ---- current state (as postgres): can the app role already CRUD the tables? ----
  const { pool: admin, ref, schema } = connectProdAdmin();
  console.log(`[phaseA] ref=${ref} (PROD) schema=${schema} app_role=${APP_ROLE}  mode=${EXECUTE ? "EXECUTE" : "PREVIEW"}`);
  const privCheck = async () => {
    const out = {};
    for (const t of RELATIONAL_TABLES) {
      const r = await admin.query(
        `select has_table_privilege($1, $2, 'SELECT') s, has_table_privilege($1,$2,'INSERT') i,
                has_table_privilege($1,$2,'UPDATE') u, has_table_privilege($1,$2,'DELETE') d`,
        [APP_ROLE, `${schema}.${t}`]
      );
      out[t] = r.rows[0];
    }
    return out;
  };
  const before = await privCheck();
  const lacking = RELATIONAL_TABLES.filter((t) => !(before[t].s && before[t].i && before[t].u && before[t].d));
  console.log(`[phaseA] tables where ${APP_ROLE} lacks full CRUD now: ${lacking.length}/18${lacking.length ? " → " + lacking.join(",") : ""}`);

  if (!EXECUTE) {
    console.log(`[phaseA] would (as migrator/owner): grant select,insert,update,delete on each of the 18 tables to ${APP_ROLE} (+ usage,select on any migrator-owned sequences).`);
    console.log(`[phaseA] PREVIEW only — no grants. Re-run with --execute.`);
    await admin.end();
    return;
  }

  // ---- grant, as the migrator (owner) ----
  const { pool: mig } = connectProdMigrator();
  const mc = await mig.connect();
  try {
    await mc.query("begin");
    for (const t of RELATIONAL_TABLES) {
      await mc.query(`grant select, insert, update, delete on ${schema}."${t}" to ${APP_ROLE}`);
    }
    // any sequences the migrator owns in this schema (none expected — text PKs) → usage,select
    const seqs = await mc.query(
      `select sequencename from pg_sequences where schemaname=$1 and sequenceowner=current_user`,
      [schema]
    );
    for (const { sequencename } of seqs.rows) {
      await mc.query(`grant usage, select on sequence ${schema}."${sequencename}" to ${APP_ROLE}`);
    }
    await mc.query("commit");
    console.log(`[phaseA] granted CRUD on 18 tables (+ ${seqs.rows.length} sequences) to ${APP_ROLE} (committed, by owner expressline_migrator).`);
  } catch (e) {
    await mc.query("rollback");
    throw e;
  } finally {
    mc.release();
    await mig.end();
  }

  // ---- HARD GATE: prove as postgres — in-txn S/I/U/D no-op then ROLLBACK, per table ----
  const results = [];
  for (const t of RELATIONAL_TABLES) {
    const col0 = `"${TABLE_META[t].cols[0]}"`;
    const c = await admin.connect();
    let ok = false, detail = "";
    try {
      await c.query("begin");
      await c.query(`select 1 from ${schema}."${t}" limit 1`);                 // SELECT
      await c.query(`insert into ${schema}."${t}" select * from ${schema}."${t}" where false`); // INSERT priv, 0 rows
      await c.query(`update ${schema}."${t}" set ${col0} = ${col0} where false`);                // UPDATE priv, 0 rows
      await c.query(`delete from ${schema}."${t}" where false`);                // DELETE priv, 0 rows
      await c.query("rollback");                                               // touch nothing
      ok = true;
    } catch (e) {
      try { await c.query("rollback"); } catch {}
      detail = `[${e.code}] ${e.message}`;
    } finally {
      c.release();
    }
    results.push({ t, ok, detail });
    console.log(`   ${t.padEnd(24)} S+I+U+D+rollback: ${ok ? "PASS ✅" : "FAIL ❌ " + detail}`);
  }
  const gatePass = results.every((r) => r.ok);
  console.log(`\n[phaseA] HARD GATE — app role ${APP_ROLE} full CRUD on all 18 tables (proved, rolled back): ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
  await admin.end();
  if (!gatePass) process.exit(2);
})().catch((e) => {
  console.error("[phaseA] ERROR:", e.message);
  process.exit(1);
});
