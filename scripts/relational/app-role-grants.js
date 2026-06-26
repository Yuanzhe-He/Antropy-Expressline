// SINGLE SOURCE for the least-privilege `expressline_app` grant set + the HARD GATE verify.
// Used by the sandbox proof (sandbox-create-app-role.js) and the prod creator
// (prod-F-create-app-role.js) so what is proven on the sandbox is the exact same grant set
// applied to prod.
//
// expressline_app = the app's intended RUNTIME role: it can do everything the app needs at
// runtime and NOTHING else —
//   • SELECT/INSERT/UPDATE/DELETE on the 18 entity tables
//   • SELECT/INSERT/UPDATE on app_state          (read + upsert the users row; no delete)
//   • SELECT/INSERT on quote_snapshots           (append-only audit) + its bigserial sequence
//   • USAGE on the expressline schema
// and explicitly NOT: cross-schema (joyas/punas), table ownership, DDL, or
// createrole/createdb/bypassRLS/superuser. (The app's startup DDL-ensure is owner-only and
// must be skipped when running as this role — see the switch prerequisite in the report.)
const { RELATIONAL_TABLES, q } = require("../../src/lib/db/relational-repo");
const { TABLE_META } = require("../../src/lib/db/relational-map");

function appRoleGrantSql(schema, role) {
  const s = q(schema);
  const r = q(role);
  const out = [`grant usage on schema ${s} to ${r}`];
  for (const t of RELATIONAL_TABLES) out.push(`grant select, insert, update, delete on ${s}.${q(t)} to ${r}`);
  out.push(`grant select, insert, update on ${s}.app_state to ${r}`);
  out.push(`grant select, insert on ${s}.quote_snapshots to ${r}`);
  out.push(`grant usage, select on sequence ${s}.quote_snapshots_id_seq to ${r}`);
  return out;
}

// no-op CRUD probe (select + insert…where false + update…where false + delete…where false),
// all inside a transaction that is ROLLED BACK — proves privilege without changing data.
async function crudNoop(pool, schema, table) {
  const col0 = q(TABLE_META[table].cols[0]);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`select 1 from ${q(schema)}.${q(table)} limit 1`);
    await c.query(`insert into ${q(schema)}.${q(table)} select * from ${q(schema)}.${q(table)} where false`);
    await c.query(`update ${q(schema)}.${q(table)} set ${col0} = ${col0} where false`);
    await c.query(`delete from ${q(schema)}.${q(table)} where false`);
    await c.query("rollback");
    return true;
  } catch (e) { try { await c.query("rollback"); } catch {} return `[${e.code}] ${e.message.split("\n")[0]}`; }
  finally { c.release(); }
}

// HARD GATE — connect AS the role (appPool) and prove sufficiency + tightness + isolation.
// Returns { pass, lines } where lines is human-readable evidence (NO secrets).
async function verifyAppRole({ appPool, adminPool, schema, role, tenantTables = [] }) {
  const lines = [];
  let pass = true;
  const note = (ok, msg) => { if (!ok) pass = false; lines.push(`  ${ok ? "✅" : "🔴"} ${msg}`); };

  // (a) full CRUD on the 18 entity tables (no-op + rollback)
  let crudFails = [];
  for (const t of RELATIONAL_TABLES) {
    const r = await crudNoop(appPool, schema, t);
    if (r !== true) crudFails.push(`${t}: ${r}`);
  }
  note(crudFails.length === 0, `18-table CRUD (S/I/U/D no-op + rollback): ${crudFails.length === 0 ? "all PASS" : crudFails.length + " FAIL → " + crudFails.slice(0, 3).join("; ")}`);

  // (b) app_state R/W (users upsert)
  let asOk = true, asMsg = "select+insert+update";
  const asc = await appPool.connect();
  try {
    await asc.query("begin");
    await asc.query(`select 1 from ${q(schema)}.app_state limit 1`);
    await asc.query(`insert into ${q(schema)}.app_state (key,payload) values ('__probe__','{}'::jsonb) on conflict (key) do update set payload=excluded.payload, updated_at=now()`);
    await asc.query("rollback");
  } catch (e) { try { await asc.query("rollback"); } catch {} asOk = false; asMsg = `[${e.code}] ${e.message.split("\n")[0]}`; }
  finally { asc.release(); }
  note(asOk, `app_state R/W (users): ${asMsg}`);

  // (c) quote_snapshots INSERT (via bigserial sequence)
  let qsOk = true, qsMsg = "insert+select";
  const qsc = await appPool.connect();
  try {
    await qsc.query("begin");
    await qsc.query(`insert into ${q(schema)}.quote_snapshots (module_key,input_payload,result_payload) values ('quote','{}'::jsonb,'{}'::jsonb)`);
    await qsc.query(`select 1 from ${q(schema)}.quote_snapshots limit 1`);
    await qsc.query("rollback");
  } catch (e) { try { await qsc.query("rollback"); } catch {} qsOk = false; qsMsg = `[${e.code}] ${e.message.split("\n")[0]}`; }
  finally { qsc.release(); }
  note(qsOk, `quote_snapshots INSERT (bigserial seq): ${qsMsg}`);

  // (d) ISOLATION — denied (42501) on the other projects' tables
  for (const t of tenantTables) {
    let verdict;
    try { await appPool.query(`select 1 from ${t} limit 1`); verdict = "NOT DENIED ❌"; }
    catch (e) { verdict = e.code === "42501" ? "permission denied (42501)" : `[${e.code}] ${e.message.split("\n")[0].slice(0, 40)}`; }
    note(verdict.includes("42501"), `isolation ${t}: ${verdict}`);
  }

  // (e) role attributes must be minimal (checked via admin)
  if (adminPool) {
    const a = (await adminPool.query(`select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin from pg_roles where rolname=$1`, [role])).rows[0];
    const tight = a && !a.rolsuper && !a.rolcreaterole && !a.rolcreatedb && !a.rolbypassrls && a.rolcanlogin;
    note(tight, `attributes: superuser=${a.rolsuper} createrole=${a.rolcreaterole} createdb=${a.rolcreatedb} bypassRLS=${a.rolbypassrls} canlogin=${a.rolcanlogin}`);
  }

  return { pass, lines };
}

module.exports = { appRoleGrantSql, crudNoop, verifyAppRole };
