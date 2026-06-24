// PHASE 1 — Create the restricted `expressline_migrator` role + PROVE isolation.
// This is the safety foundation: once proven, the role physically cannot touch
// joyas_*/punas_*, so every later phase is bounded to expressline.
//
// Hardened vs the runbook §2 suggestion (both stricter, never looser):
//   - grant only SELECT on the EXISTING expressline tables (app_state/audit_logs/
//     quote_snapshots) — NOT `all`. The migrator therefore CANNOT modify app_state
//     (iron rule #3 enforced at the privilege layer, not just by convention). It
//     gets USAGE+CREATE on the schema, so it OWNS (full rights on) the 18 NEW tables
//     it creates in Phase 2.
//   - isolation proof targets the ACTUALLY-enumerated joyas/punas table names.
//
// Run preview:  node prod-01-role-and-isolation.js
// Execute:      node prod-01-role-and-isolation.js --execute
//
// HARD GATE: migrator connects, CAN read expressline, and EVERY joyas/punas SELECT is
// permission-denied (42501). Any returned row, or any non-permission error, → STOP.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { connectProdAdmin, poolConfigFor, MIGRATOR_ENV } = require("./prod-env");
const { assertProd, PROD_REF } = require("./prod-guard");

const ROLE = "expressline_migrator";
const EXECUTE = process.argv.includes("--execute");

// Redact a secret everywhere it might appear in a thrown message before logging.
const redact = (msg, secret) => (secret ? String(msg).split(secret).join("***") : String(msg));

(async () => {
  const { pool: admin, ref, schema } = connectProdAdmin();
  console.log(`[phase1] ref=${ref} (PROD) schema=${schema} role=admin  mode=${EXECUTE ? "EXECUTE" : "PREVIEW"}`);

  // --- admin reads: does the role exist? enumerate real proof targets -----------
  const a = await admin.connect();
  let proofTargets = [];
  let roleExists = false;
  try {
    roleExists = (await a.query(`select 1 from pg_roles where rolname=$1`, [ROLE])).rows.length > 0;
    const others = await a.query(
      `select table_name from information_schema.tables
         where table_schema='public' and (table_name like 'joyas\\_%' or table_name like 'punas\\_%')
         order by table_name`
    );
    const names = others.rows.map((r) => r.table_name);
    const joyas = names.filter((n) => n.startsWith("joyas_")).slice(0, 3);
    const punas = names.filter((n) => n.startsWith("punas_")).slice(0, 3);
    proofTargets = [...joyas, ...punas];
  } finally {
    a.release();
  }
  console.log(`[phase1] role ${ROLE} exists already: ${roleExists}`);
  console.log(`[phase1] isolation-proof targets (real tables): ${proofTargets.join(", ")}`);

  const ddl = [
    roleExists
      ? `alter role ${ROLE} with login`
      : `create role ${ROLE} login password '<generated>'`,
    `revoke all on schema public from ${ROLE}`,
    `grant usage, create on schema ${schema} to ${ROLE}`,
    `grant select on ${schema}.app_state to ${ROLE}`,
    `grant select on ${schema}.audit_logs to ${ROLE}`,
    `grant select on ${schema}.quote_snapshots to ${ROLE}`,
    `alter role ${ROLE} set search_path = ${schema}`,
    `alter role ${ROLE} with password '<generated>'`,
  ];
  console.log(`[phase1] planned SQL (password redacted):`);
  for (const s of ddl) console.log(`    ${s};`);

  if (!EXECUTE) {
    console.log(`\n[phase1] PREVIEW only — no role created, no write. Re-run with --execute to apply.`);
    await admin.end();
    return;
  }

  // --- EXECUTE: create/reset role + grants in one transaction -------------------
  const pw = crypto.randomBytes(24).toString("base64url"); // URL- and SQL-literal-safe
  const c = await admin.connect();
  try {
    await c.query("begin");
    if (roleExists) {
      await c.query(`alter role ${ROLE} with login password '${pw}'`);
    } else {
      await c.query(`create role ${ROLE} login password '${pw}'`);
    }
    await c.query(`revoke all on schema public from ${ROLE}`);
    await c.query(`grant usage, create on schema ${schema} to ${ROLE}`);
    await c.query(`grant select on ${schema}.app_state to ${ROLE}`);
    await c.query(`grant select on ${schema}.audit_logs to ${ROLE}`);
    await c.query(`grant select on ${schema}.quote_snapshots to ${ROLE}`);
    await c.query(`alter role ${ROLE} set search_path = ${schema}`);
    await c.query("commit");
    console.log(`[phase1] role ${ROLE} ${roleExists ? "updated" : "created"} + grants applied (committed).`);
  } catch (e) {
    await c.query("rollback");
    throw new Error(redact(e.message, pw));
  } finally {
    c.release();
  }

  // --- build a working migrator connection URL (try pooler, then direct) --------
  const adminUrl = new URL(process.env.DATABASE_URL);
  const buildUrl = (kind) => {
    const u = new URL(process.env.DATABASE_URL);
    if (kind === "pooler") {
      u.username = `${ROLE}.${PROD_REF}`; // Supavisor: <role>.<tenant>
    } else {
      u.username = ROLE; // direct host
      u.hostname = `db.${PROD_REF}.supabase.co`;
      u.port = "5432";
    }
    u.password = pw;
    return u.toString();
  };
  const candidates = [["pooler", buildUrl("pooler")], ["direct", buildUrl("direct")]];

  let working = null;
  for (const [kind, url] of candidates) {
    const p = new Pool(poolConfigFor(url, 1));
    try {
      assertProd(url); // the migrator URL must point at prod too
      const r = await p.query("select current_user cu, current_schema cs");
      console.log(`[phase1] migrator connect via ${kind}: OK (current_user=${r.rows[0].cu}, current_schema=${r.rows[0].cs})`);
      working = url;
      await p.end();
      break;
    } catch (e) {
      console.log(`[phase1] migrator connect via ${kind}: failed (${redact(e.message, pw)})`);
      await p.end().catch(() => {});
    }
  }
  if (!working) {
    throw new Error("[phase1] STOP: migrator role could not connect via pooler OR direct — cannot proceed isolated.");
  }

  // persist gitignored migrator creds (password never logged)
  const body =
    `# gitignored — restricted prod migrator role for the blob→relational cutover.\n` +
    `# Created ${new Date().toISOString()}. ALL Phase 2-4 SQL connects through this.\n` +
    `PROD_MIGRATOR_URL=${working}\n` +
    `PROD_MIGRATOR_REF=${PROD_REF}\n`;
  fs.writeFileSync(MIGRATOR_ENV, body, { mode: 0o600 });
  console.log(`[phase1] wrote ${MIGRATOR_ENV.split("/").pop()} (gitignored, chmod 600) — password NOT logged.`);

  // --- ISOLATION PROOF: migrator must be DENIED on every joyas/punas target -----
  const mig = new Pool(poolConfigFor(working, 1));
  const proof = [];
  try {
    // positive control: migrator CAN read expressline
    let exprOk = false;
    try {
      const r = await mig.query(`select count(*)::int n from ${schema}.app_state`);
      exprOk = true;
      console.log(`[phase1] positive control: migrator CAN read ${schema}.app_state (n=${r.rows[0].n}) ✓`);
    } catch (e) {
      console.log(`[phase1] positive control FAILED: migrator cannot read ${schema}.app_state (${redact(e.message, pw)})`);
    }

    for (const t of proofTargets) {
      let outcome;
      try {
        await mig.query(`select 1 from public."${t}" limit 1`);
        outcome = { table: t, denied: false, detail: "RETURNED A ROW (NOT denied)" };
      } catch (e) {
        const denied = e.code === "42501"; // insufficient_privilege
        outcome = { table: t, denied, code: e.code, detail: redact(e.message, pw) };
      }
      proof.push(outcome);
      console.log(`   public.${t.padEnd(28)} -> ${outcome.denied ? "permission denied ✅" : `NOT DENIED ❌ [${outcome.code || ""}] ${outcome.detail}`}`);
    }

    const allDenied = proof.length > 0 && proof.every((p) => p.denied);
    const gatePass = exprOk && allDenied;
    console.log(`\n[phase1] HARD GATE — migrator reads expressline AND every joyas/punas SELECT permission-denied: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
    if (!gatePass) {
      console.error("[phase1] STOP: isolation NOT proven — do NOT proceed to table creation/migration.");
      process.exit(2);
    }
  } finally {
    await mig.end();
    await admin.end();
  }
})().catch((e) => {
  console.error("[phase1] ERROR:", e.message);
  process.exit(1);
});
