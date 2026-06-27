// PHASE G — install ALTER DEFAULT PRIVILEGES so EVERY FUTURE table/sequence created in the
// `expressline` schema is AUTO-GRANTED to the least-privilege runtime role `expressline_app`.
// This roots out the "add a table → forget to grant → app hits 42501 even though the table
// exists" footgun (the confusing "table is there but the app can't read it" symptom), turning
// the soft "remember to grant" rule into a standing mechanism.
//
// WHY TWO ROLES: ALTER DEFAULT PRIVILEGES is keyed by the role that CREATES the object. The
// roles that create tables in `expressline` are `postgres` (owner) and `expressline_migrator`
// (migration tooling). So we set default privileges for BOTH — otherwise a table created by
// the role we skipped would still need a manual grant.
//
// WHY EACH FROM ITS OWN CONNECTION: `ALTER DEFAULT PRIVILEGES FOR ROLE X` requires the current
// role to be a member of X. Rather than depend on the postgres<->migrator membership (which is
// platform-managed by supabase_admin and not under our durable control), we run each role's
// statement FROM THAT ROLE'S OWN CONNECTION (FOR ROLE <self>). Membership-independent + durable.
//
// SAFETY: ADDITIVE + REVERSIBLE (--revoke). Touches ONLY the `expressline` schema (never
// joyas_*/punas_* — they live in `public.*`, so cross-project isolation is unaffected). Does
// NOT change the app runtime, existing table grants, ownership, schema, or data. assertProd-
// gated on BOTH connections. No secrets printed.
//
// Default privileges affect ONLY tables created AFTER this runs; existing tables keep their
// (already-correct, deliberately-narrower for app_state/quote_snapshots) grants untouched.
//
//   preview:  node scripts/relational/prod-G-default-privs.js
//   execute:  node scripts/relational/prod-G-default-privs.js --execute
//   verify:   node scripts/relational/prod-G-default-privs.js --verify
//   revoke:   node scripts/relational/prod-G-default-privs.js --revoke
//   probe:    node scripts/relational/prod-G-default-privs.js --probe   (live throwaway-table proof)
const { Pool } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
const { connectProdAdmin, connectProdMigrator, poolConfigFor } = require("./prod-env");
const { assertProd } = require("./prod-guard");

const APP = "expressline_app";
const SCHEMA = "expressline";
const TENANT_TABLES = ["public.punas_customers", "public.joyas_asset_products"];

// The two table-creating roles, each paired with how to open a connection AS that role.
const CREATORS = ["postgres", "expressline_migrator"];

function grantSql(role) {
  return [
    `alter default privileges for role ${role} in schema ${SCHEMA} grant select, insert, update, delete on tables to ${APP}`,
    `alter default privileges for role ${role} in schema ${SCHEMA} grant usage, select on sequences to ${APP}`,
  ];
}
function revokeSql(role) {
  return [
    `alter default privileges for role ${role} in schema ${SCHEMA} revoke select, insert, update, delete on tables from ${APP}`,
    `alter default privileges for role ${role} in schema ${SCHEMA} revoke usage, select on sequences from ${APP}`,
  ];
}

// Open a pool AS the given creating role (so FOR ROLE <self> works without membership games).
function connectAs(role) {
  if (role === "postgres") return connectProdAdmin(); // { pool, ref, schema }
  if (role === "expressline_migrator") return connectProdMigrator();
  throw new Error(`no connection helper for role ${role}`);
}

// expressline_app pool (for the live probe) from gitignored .env.expressline-app — never printed.
function connectApp() {
  const envPath = path.join(__dirname, "../../.env.expressline-app");
  const url = fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.startsWith("EXPRESSLINE_APP_URL="))
    .map((l) => l.slice("EXPRESSLINE_APP_URL=".length).trim())[0];
  if (!url) throw new Error("[prod-G] EXPRESSLINE_APP_URL missing in .env.expressline-app");
  assertProd(url);
  return new Pool(poolConfigFor(url));
}

// Read the schema's default-privilege entries, keyed by creating role + object type.
async function readDefaclo(adminPool) {
  const rows = (
    await adminPool.query(
      `select defaclrole::regrole::text as creator, defaclobjtype as objtype, defaclacl::text as acl
         from pg_default_acl
        where defaclnamespace = $1::regnamespace
        order by creator, objtype`,
      [SCHEMA]
    )
  ).rows;
  return rows;
}

function aclHasApp(acl, wantLetters) {
  // acl is like "{expressline_app=arwd/postgres,...}". find the expressline_app grant.
  if (!acl) return false;
  const m = acl.match(new RegExp(`${APP}=([a-zA-Z*]+)/`));
  if (!m) return false;
  const have = m[1].replace(/\*/g, "");
  return [...wantLetters].every((c) => have.includes(c));
}

async function verify(adminPool) {
  const rows = await readDefaclo(adminPool);
  console.log("[prod-G] pg_default_acl for schema expressline:");
  if (!rows.length) console.log("   (none)");
  rows.forEach((r) => console.log(`   creator=${r.creator} objtype=${r.objtype} acl=${r.acl}`));
  // expected: for each creator, tables (r) -> arwd, sequences (S) -> rU (letters: r=SELECT a=INSERT w=UPDATE d=DELETE U=USAGE)
  let pass = true;
  for (const role of CREATORS) {
    const tbl = rows.find((r) => r.creator === role && r.objtype === "r");
    const seq = rows.find((r) => r.creator === role && r.objtype === "S");
    const tOk = tbl && aclHasApp(tbl.acl, "arwd");
    const sOk = seq && aclHasApp(seq.acl, "rU");
    if (!tOk || !sOk) pass = false;
    console.log(`   ${tOk ? "✅" : "🔴"} ${role}: future TABLES -> ${APP} S/I/U/D  | ${sOk ? "✅" : "🔴"} future SEQUENCES -> ${APP} USAGE/SELECT`);
  }
  console.log(`[prod-G] VERIFY: ${pass ? "PASS ✅ — both creating roles auto-grant future objects to expressline_app" : "INCOMPLETE 🔴"}`);
  return pass;
}

async function applyForRole(role, sqls, label) {
  const { pool, ref } = connectAs(role);
  try {
    console.log(`[prod-G] (${label}) AS ${role} ref=${ref}`);
    for (const s of sqls) {
      await pool.query(s);
      console.log(`   ok: ${s}`);
    }
  } finally {
    await pool.end();
  }
}

async function probe() {
  console.log("[prod-G] LIVE PROBE — create ungranted throwaway tables as each creator, read/write AS expressline_app.\n");
  const probes = [
    { role: "postgres", table: "_defpriv_probe_pg" },
    { role: "expressline_migrator", table: "_defpriv_probe_mig" },
  ];
  // 1) create + seed each throwaway table as its creating role (NO explicit grant)
  for (const p of probes) {
    const { pool } = connectAs(p.role);
    try {
      await pool.query(`create table if not exists ${SCHEMA}."${p.table}" (id int)`);
      await pool.query(`insert into ${SCHEMA}."${p.table}" (id) values (1)`);
      console.log(`   [setup] ${p.role} created + seeded ${SCHEMA}.${p.table} (no explicit grant)`);
    } finally {
      await pool.end();
    }
  }
  // 2) AS expressline_app: prove auto-grant on the new tables + isolation + existing tables
  const app = connectApp();
  let pass = true;
  const note = (ok, msg) => { if (!ok) pass = false; console.log(`   ${ok ? "✅" : "🔴"} ${msg}`); };
  try {
    for (const p of probes) {
      let r;
      try {
        const sel = await app.query(`select count(*)::int n from ${SCHEMA}."${p.table}"`);
        await app.query(`insert into ${SCHEMA}."${p.table}" (id) values (2)`);
        r = `SELECT (${sel.rows[0].n} row) + INSERT OK`;
        note(true, `auto-grant on ${p.table} (created by ${p.role}): ${r}`);
      } catch (e) {
        note(false, `auto-grant on ${p.table} (created by ${p.role}): [${e.code}] ${e.message.split("\n")[0]}`);
      }
    }
    // isolation still denied
    for (const t of TENANT_TABLES) {
      let verdict;
      try { await app.query(`select 1 from ${t} limit 1`); verdict = "NOT DENIED ❌"; }
      catch (e) { verdict = e.code === "42501" ? "permission denied (42501)" : `[${e.code}]`; }
      note(verdict.includes("42501"), `isolation ${t}: ${verdict}`);
    }
    // existing tables still fine
    try { await app.query(`select 1 from ${SCHEMA}.carriers limit 1`); note(true, "existing expressline.carriers still readable"); }
    catch (e) { note(false, `existing expressline.carriers: [${e.code}]`); }
    try { await app.query(`select 1 from ${SCHEMA}.app_state limit 1`); note(true, "existing expressline.app_state still readable"); }
    catch (e) { note(false, `existing expressline.app_state: [${e.code}]`); }
  } finally {
    await app.end();
    // 3) cleanup: drop each throwaway table as its owner (always, even on failure)
    for (const p of probes) {
      const { pool } = connectAs(p.role);
      try { await pool.query(`drop table if exists ${SCHEMA}."${p.table}"`); console.log(`   [cleanup] dropped ${SCHEMA}.${p.table}`); }
      catch (e) { console.log(`   [cleanup] FAILED to drop ${p.table}: ${e.message.split("\n")[0]}`); }
      finally { await pool.end(); }
    }
  }
  console.log(`\n[prod-G] PROBE HARD GATE — auto-grant works for both creators + isolation intact + existing tables OK: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  if (!pass) process.exitCode = 2;
}

(async () => {
  const mode = process.argv.includes("--execute") ? "execute"
    : process.argv.includes("--verify") ? "verify"
    : process.argv.includes("--revoke") ? "revoke"
    : process.argv.includes("--probe") ? "probe"
    : "preview";
  const { pool: admin, ref } = connectProdAdmin();
  console.log(`[prod-G] ref=${ref} (PROD) schema=${SCHEMA} target=${APP} mode=${mode}\n`);

  if (mode === "preview") {
    console.log("[prod-G] would set DEFAULT PRIVILEGES (additive, reversible):");
    for (const role of CREATORS) grantSql(role).forEach((s) => console.log(`   ${s}`));
    console.log("\n[prod-G] current state:");
    await verify(admin);
    await admin.end();
    return;
  }
  if (mode === "verify") { await verify(admin); await admin.end(); return; }
  await admin.end(); // execute/revoke/probe use per-role connections below

  if (mode === "execute") {
    for (const role of CREATORS) await applyForRole(role, grantSql(role), "grant");
    console.log("");
    const { pool: a2 } = connectProdAdmin();
    await verify(a2);
    await a2.end();
  } else if (mode === "revoke") {
    for (const role of CREATORS) await applyForRole(role, revokeSql(role), "revoke");
    console.log("");
    const { pool: a2 } = connectProdAdmin();
    await verify(a2);
    await a2.end();
  } else if (mode === "probe") {
    await probe();
  }
})().catch((e) => { console.error("[prod-G] ERROR:", e.message); process.exit(1); });
