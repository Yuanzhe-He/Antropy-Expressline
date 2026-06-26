// SANDBOX-ONLY: create the least-privilege `expressline_app` role + grants on an isolated
// sandbox schema, then PROBE that it is (a) sufficient for the app's DML, (b) tight
// (denied on joyas/punas, no DDL/ownership). Generates a strong password IN-PROCESS and
// writes the sandbox app connection string ONLY to the gitignored .env.sandbox-app — the
// password is NEVER printed and NEVER committed. assertSandbox-gated (fail-closed).
//
//   node scripts/relational/sandbox-create-app-role.js
//
// Output: per-probe PASS/FAIL. The DDL-ensure probe answers the crux — can a non-owner
// least-priv role run the app's startup buildSchemaDDL (ALTER ADD COLUMN / CREATE INDEX)?
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { connectSandbox, sandboxPoolConfig } = require("./sandbox-env");
const { assertSandbox } = require("../sandbox-guard");
const relRepo = require("../../src/lib/db/relational-repo");
const { RELATIONAL_TABLES } = relRepo;
const { decompose, TABLE_META } = require("../../src/lib/db/relational-map");
const { normalizeShippingData } = require("../../src/lib/store");

const ROLE = "expressline_app";
const SCHEMA = "el_approle"; // isolated sandbox test schema
const APP_ENV = path.join(__dirname, "../../.env.sandbox-app");

// the PRECISE least-privilege grant set — SINGLE SOURCE in ./app-role-grants.js (the exact
// same set is applied to prod by prod-F-create-app-role.js, so sandbox proves what prod gets).
const { appRoleGrantSql } = require("./app-role-grants");

// migrateDatabase-equivalent base tables (app_state/audit_logs/quote_snapshots), so the
// isolated schema mirrors prod exactly before granting.
function baseTablesSql(schema) {
  const s = `"${schema}"`;
  return [
    `create table if not exists ${s}.app_state (key text primary key, payload jsonb not null, revision integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
    `create table if not exists ${s}.audit_logs (id bigserial primary key, actor text, action text not null, target text, before_payload jsonb, after_payload jsonb, created_at timestamptz not null default now())`,
    `create table if not exists ${s}.quote_snapshots (id bigserial primary key, module_key text not null, business_nature text, input_payload jsonb not null, result_payload jsonb not null, created_at timestamptz not null default now())`,
  ];
}

async function crudNoop(pool, schema, table) {
  const col0 = `"${TABLE_META[table].cols[0]}"`;
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(`select 1 from "${schema}"."${table}" limit 1`);
    await c.query(`insert into "${schema}"."${table}" select * from "${schema}"."${table}" where false`);
    await c.query(`update "${schema}"."${table}" set ${col0} = ${col0} where false`);
    await c.query(`delete from "${schema}"."${table}" where false`);
    await c.query("rollback");
    return true;
  } catch (e) { try { await c.query("rollback"); } catch {} return `[${e.code}] ${e.message.split("\n")[0]}`; }
  finally { c.release(); }
}

(async () => {
  const { pool: admin, ref } = connectSandbox(); // assertSandbox inside
  console.log(`[app-role] ref=${ref} (SANDBOX) schema=${SCHEMA} role=${ROLE}\n`);

  // 1) set up the isolated schema AS ADMIN (owner), mirroring prod: 18 tables + base + seed
  await admin.query(`drop schema if exists "${SCHEMA}" cascade`);
  await admin.query(`create schema "${SCHEMA}"`);
  const ac = await admin.connect();
  try {
    await ac.query("begin");
    for (const stmt of relRepo.buildSchemaDDL(SCHEMA)) await ac.query(stmt);
    for (const stmt of baseTablesSql(SCHEMA)) await ac.query(stmt);
    await ac.query("commit");
  } finally { ac.release(); }
  // minimal seed via decompose+upsert (as admin)
  const seed = normalizeShippingData({ modules: { handover: { shippingLines: [{ id: "seed-line", name: "Seed Line", notes: {} }], containerTypes: [{ key: "gp20", label: "GP20", rateGroup: "dry" }] }, customs: { ports: [{ id: "seed-port", name: "Seed Port", terminals: [{ id: "seed-term", name: "Seed Term" }] }], yards: [{ id: "seed-yard", name: "Seed Yard" }] }, inland: { origins: [{ id: "seed-orig", name: "Seed Orig", lat: 19, lng: -104 }], destinations: [], rateEntries: [] }, quote: { notes: [] } } });
  const sc = await admin.connect();
  try { await sc.query("begin"); await relRepo.upsertAllTables(sc, SCHEMA, decompose(seed)); await sc.query("commit"); }
  finally { sc.release(); }
  console.log("[app-role] isolated schema set up as admin (18 tables + base + seed) ✅");

  // 2) generate password IN-PROCESS (never printed), create role + grants
  const password = crypto.randomBytes(24).toString("base64url"); // strong, url-safe (no shell/url issues)
  await admin.query(`drop role if exists ${ROLE}`);
  await admin.query(`create role ${ROLE} login password '${password.replace(/'/g, "''")}'`);
  for (const stmt of appRoleGrantSql(SCHEMA, ROLE)) await admin.query(stmt);
  console.log(`[app-role] role ${ROLE} created + ${appRoleGrantSql(SCHEMA, ROLE).length} grants applied (password NOT printed) ✅`);

  // write the sandbox app connection string to the gitignored .env.sandbox-app (never committed)
  const adminUrl = new URL(process.env.DATABASE_URL);
  const appUrl = `postgresql://${ROLE}:${encodeURIComponent(password)}@${adminUrl.host}${adminUrl.pathname}?sslmode=require`;
  fs.writeFileSync(APP_ENV, `# gitignored — sandbox expressline_app cred for sandbox-admin-crud-test.js (least-priv run)\nSANDBOX_APP_URL=${appUrl}\nSANDBOX_APP_SCHEMA=${SCHEMA}\n`, { mode: 0o600 });
  console.log(`[app-role] wrote sandbox app cred to gitignored ${path.basename(APP_ENV)} (NOT committed, NOT printed)`);

  // 3) connect AS expressline_app (direct connection on sandbox: user=role, no dot)
  const appPool = new Pool({ connectionString: appUrl.replace(/[?&]sslmode=require/, ""), ssl: { rejectUnauthorized: false }, max: 4 });

  // ---- PROBE A: can the non-owner role run the app's startup DDL-ensure? ----
  console.log("\n## PROBE A — startup DDL-ensure as expressline_app (buildSchemaDDL on EXISTING schema)");
  const ddl = [...relRepo.buildSchemaDDL(SCHEMA), ...baseTablesSql(SCHEMA)];
  let ddlFails = [];
  for (const stmt of ddl) {
    try { await appPool.query(stmt); }
    catch (e) { ddlFails.push(`[${e.code}] ${stmt.split("\n")[0].slice(0, 70)} — ${e.message.split("\n")[0].slice(0, 60)}`); }
  }
  console.log(ddlFails.length === 0
    ? `  ✅ all ${ddl.length} ensure statements ran clean as ${ROLE} (no DDL privilege needed for no-ops)`
    : `  🔴 ${ddlFails.length}/${ddl.length} ensure statements FAILED as ${ROLE}:`);
  ddlFails.slice(0, 6).forEach((f) => console.log(`     ${f}`));

  // ---- PROBE B: isolation — denied on joyas/punas ----
  console.log("\n## PROBE B — isolation (joyas/punas denied)");
  let iso = {};
  for (const t of ["public.punas_customers", "public.joyas_products"]) {
    try { await appPool.query(`select 1 from ${t} limit 1`); iso[t] = "NOT DENIED ❌"; }
    catch (e) { iso[t] = e.code === "42501" ? "permission denied ✅" : `[${e.code}] ${e.message.split("\n")[0].slice(0,40)}`; }
  }
  Object.entries(iso).forEach(([t, v]) => console.log(`  ${t.padEnd(24)} ${v}`));

  // ---- PROBE C: sufficiency — DML the app needs ----
  console.log("\n## PROBE C — sufficiency (the DML the app runs)");
  const carriersCrud = await crudNoop(appPool, SCHEMA, "carriers");
  console.log(`  18-table CRUD (carriers no-op S/I/U/D + rollback): ${carriersCrud === true ? "OK ✅" : "FAIL ❌ " + carriersCrud}`);
  // app_state: select + insert + update (users upsert)
  let appStateOk = "?";
  const asc = await appPool.connect();
  try {
    await asc.query("begin");
    await asc.query(`select 1 from "${SCHEMA}".app_state limit 1`);
    await asc.query(`insert into "${SCHEMA}".app_state (key,payload) values ('__probe__','{}'::jsonb) on conflict (key) do update set payload=excluded.payload, updated_at=now()`);
    await asc.query("rollback");
    appStateOk = "OK ✅ (select+insert+update users)";
  } catch (e) { try { await asc.query("rollback"); } catch {} appStateOk = `FAIL ❌ [${e.code}] ${e.message.split("\n")[0]}`; }
  finally { asc.release(); }
  console.log(`  app_state R/W (users): ${appStateOk}`);
  // quote_snapshots: insert (needs seq usage)
  let snapOk = "?";
  const qsc = await appPool.connect();
  try {
    await qsc.query("begin");
    await qsc.query(`insert into "${SCHEMA}".quote_snapshots (module_key,input_payload,result_payload) values ('quote','{}'::jsonb,'{}'::jsonb)`);
    await qsc.query(`select 1 from "${SCHEMA}".quote_snapshots limit 1`);
    await qsc.query("rollback");
    snapOk = "OK ✅ (insert via bigserial seq + select)";
  } catch (e) { try { await qsc.query("rollback"); } catch {} snapOk = `FAIL ❌ [${e.code}] ${e.message.split("\n")[0]}`; }
  finally { qsc.release(); }
  console.log(`  quote_snapshots INSERT: ${snapOk}`);

  // ---- role attributes (must be NO createrole/createdb/bypassrls/superuser) ----
  console.log("\n## PROBE D — role attributes (must be minimal)");
  const attr = (await admin.query(`select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin from pg_roles where rolname=$1`, [ROLE])).rows[0];
  const tight = !attr.rolsuper && !attr.rolcreaterole && !attr.rolcreatedb && !attr.rolbypassrls && attr.rolcanlogin;
  console.log(`  superuser=${attr.rolsuper} createrole=${attr.rolcreaterole} createdb=${attr.rolcreatedb} bypassRLS=${attr.rolbypassrls} canlogin=${attr.rolcanlogin} → ${tight ? "TIGHT ✅" : "⚠ too broad"}`);

  await appPool.end();
  await admin.end();
  console.log(`\n[app-role] DONE. ddl_ensure_clean=${ddlFails.length === 0} isolation_ok=${Object.values(iso).every((v)=>v.includes("✅"))} sufficiency_ok=${carriersCrud===true && appStateOk.includes("✅") && snapOk.includes("✅")} tight=${tight}`);
})().catch((e) => { console.error("[app-role] ERROR:", e.message); process.exit(1); });
