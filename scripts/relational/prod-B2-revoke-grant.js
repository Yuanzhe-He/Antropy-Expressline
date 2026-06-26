// PRESERVED 2026-06-26 (NOT run). Investigated as a pending DB-role security step. Finding:
// this revoke is a SAFE, reversible, but LOW-VALUE hygiene cleanup — postgres OWNS all 18
// tables, so the membership grants it nothing extra (zero functional impact). It does NOT
// reduce the app's real over-privilege: the app runs as `postgres` (createrole/createdb/
// bypassRLS, cross-schema access to joyas/punas). The meaningful least-privilege fix is a
// SEPARATE task — run the app as a dedicated `expressline_app` role (CRUD on the 18 tables +
// app_state R/W + quote_snapshots INSERT + schema USAGE, nothing else). See the 2026-06-26
// cleanup report (PART C). Run preview/--execute only with explicit approval.
//
// PHASE 2 B2 — revoke the now-redundant `grant expressline_migrator to postgres` membership.
// It was created during the cutover ONLY to permit transferring the 18 tables' ownership to
// postgres. The tables are now OWNED by postgres, so the membership grants postgres nothing
// extra — revoking it is zero-functional-impact least-privilege cleanup. Verifies after the
// revoke that: postgres still R/W the 18 tables (via OWNERSHIP), the migrator still R/W (its
// independent CRUD grants), and the joyas/punas isolation proof still holds.
//
// preview: node prod-B2-revoke-grant.js   |   execute: node prod-B2-revoke-grant.js --execute
// HARD GATE: ownership==18 before revoke; after revoke postgres R/W + migrator R/W + isolation OK.
const { connectProdAdmin, connectProdMigrator } = require("./prod-env");
const { RELATIONAL_TABLES } = require("../../src/lib/db/relational-repo");
const { TABLE_META } = require("../../src/lib/db/relational-map");

const MIGRATOR = "expressline_migrator";
const APP = "postgres";
const EXECUTE = process.argv.includes("--execute");

async function crudProbe(pool, schema, table) {
  const col0 = `"${TABLE_META[table].cols[0]}"`;
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`select 1 from ${schema}."${table}" limit 1`);
    await c.query(`insert into ${schema}."${table}" select * from ${schema}."${table}" where false`);
    await c.query(`update ${schema}."${table}" set ${col0} = ${col0} where false`);
    await c.query(`delete from ${schema}."${table}" where false`);
    await c.query("rollback");
    return true;
  } catch (e) {
    try { await c.query("rollback"); } catch {}
    return `[${e.code}] ${e.message}`;
  } finally {
    c.release();
  }
}

(async () => {
  const { pool: admin, ref, schema } = connectProdAdmin();
  console.log(`[B2] ref=${ref} (PROD) mode=${EXECUTE ? "EXECUTE" : "PREVIEW"}`);

  const member = await admin.query(
    `select 1 from pg_auth_members m join pg_roles r on m.roleid=r.oid join pg_roles g on m.member=g.oid where r.rolname=$1 and g.rolname=$2`,
    [MIGRATOR, APP]
  );
  const owned = (await admin.query(
    `select count(*)::int c from pg_tables where schemaname=$1 and tablename = any($2) and tableowner=$3`,
    [schema, RELATIONAL_TABLES, APP]
  )).rows[0].c;
  console.log(`[B2] postgres is member of ${MIGRATOR}: ${member.rows.length > 0} | 18-tables owned by postgres: ${owned}/18`);
  if (owned !== 18) {
    console.error("[B2] STOP: not all 18 tables are owned by postgres — revoking membership could remove access. Keeping status quo, NOT revoking.");
    await admin.end();
    process.exit(2);
  }
  if (member.rows.length === 0) {
    console.log("[B2] membership already absent — nothing to revoke (already clean).");
  }

  if (!EXECUTE) {
    console.log(`[B2] would: revoke ${MIGRATOR} from ${APP}. PREVIEW only.`);
    await admin.end();
    return;
  }

  await admin.query(`revoke ${MIGRATOR} from ${APP}`);
  console.log(`[B2] revoked ${MIGRATOR} from ${APP} (committed).`);

  const pgOk = await crudProbe(admin, schema, "carriers");
  console.log(`[B2] postgres R/W carriers after revoke (via OWNERSHIP): ${pgOk === true ? "OK ✅" : "FAIL ❌ " + pgOk}`);

  const { pool: mig } = connectProdMigrator();
  const migOk = await crudProbe(mig, schema, "carriers");
  let denied = "?";
  try {
    await mig.query(`select 1 from public."punas_customers" limit 1`);
    denied = "NOT DENIED ❌";
  } catch (e) {
    denied = e.code === "42501" ? "permission denied ✅" : `[${e.code}]`;
  }
  console.log(`[B2] migrator R/W carriers (independent CRUD grants): ${migOk === true ? "OK ✅" : "FAIL ❌ " + migOk}`);
  console.log(`[B2] migrator isolation (public.punas_customers): ${denied}`);
  await mig.end();

  const gatePass = pgOk === true && migOk === true && denied.includes("✅");
  console.log(`\n[B2] HARD GATE — postgres R/W + migrator R/W + isolation intact after revoke: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
  await admin.end();
  if (!gatePass) process.exit(2);
})().catch((e) => { console.error("[B2] ERROR:", e.message); process.exit(1); });
