// PHASE F — create the least-privilege `expressline_app` role on PROD (ADDITIVE).
//
// Proven on the sandbox first (scripts/relational/sandbox-create-app-role.js + the 30/30
// admin CRUD run as expressline_app). This applies the SAME grant set to prod, then HARD-
// GATE verifies by connecting AS the role. It is ADDITIVE and NON-DISRUPTIVE:
//   • does NOT touch the `postgres` role or its grants
//   • does NOT change Railway's DATABASE_URL — the app keeps running as `postgres`
//   • the new role just sits there, granted, until a SEPARATE switch step (and only after a
//     small app change to skip the owner-only startup DDL-ensure) flips the runtime URL.
// Fully reversible: `--revoke` drops the role.
//
// assertProd-gated. The generated password is NEVER printed and NEVER committed — it is
// written only to the gitignored .env.expressline-app (the same pattern as .env.prod-migrator).
//
//   node prod-F-create-app-role.js            # PREVIEW (no writes)
//   node prod-F-create-app-role.js --execute  # create role + grants + write env + HARD GATE
//   node prod-F-create-app-role.js --verify    # re-run the HARD GATE (reads .env.expressline-app)
//   node prod-F-create-app-role.js --revoke    # drop the role (reversal)
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { connectProdAdmin, poolConfigFor } = require("./prod-env");
const { PROD_REF } = require("./prod-guard");
const { appRoleGrantSql, verifyAppRole } = require("./app-role-grants");

const ROLE = "expressline_app";
const APP_ENV = path.join(__dirname, "../../.env.expressline-app");
const TENANT_TABLES = ["public.punas_customers", "public.joyas_products"]; // must be DENIED (42501)
const MODE = process.argv.includes("--execute") ? "execute"
  : process.argv.includes("--verify") ? "verify"
  : process.argv.includes("--revoke") ? "revoke" : "preview";

// Build the expressline_app connection string from the admin (postgres) URL: same host/port/db,
// swap the username's role part to expressline_app (pooler: <role>.<ref>), inject the password.
function buildAppUrl(adminUrl, password) {
  const u = new URL(adminUrl);
  const ref = u.username.includes(".") ? u.username.split(".").slice(1).join(".") : PROD_REF;
  u.username = u.username.includes(".") ? `${ROLE}.${ref}` : ROLE; // pooler vs direct
  u.password = password;
  return u.toString();
}

function readAppEnv() {
  if (!fs.existsSync(APP_ENV)) throw new Error("[F] .env.expressline-app not found — run --execute first");
  const env = Object.fromEntries(fs.readFileSync(APP_ENV, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  if (!env.EXPRESSLINE_APP_URL) throw new Error("[F] EXPRESSLINE_APP_URL missing in .env.expressline-app");
  return env.EXPRESSLINE_APP_URL;
}

(async () => {
  const { pool: admin, ref, schema } = connectProdAdmin(); // assertProd inside
  const grants = appRoleGrantSql(schema, ROLE);
  console.log(`[F] ref=${ref} (PROD) schema=${schema} role=${ROLE} mode=${MODE}`);
  const exists = (await admin.query(`select 1 from pg_roles where rolname=$1`, [ROLE])).rowCount > 0;

  if (MODE === "preview") {
    console.log(`[F] role exists: ${exists}`);
    console.log(`[F] WOULD (as ${schema} owner postgres): ${exists ? "skip create (exists)" : "create role " + ROLE + " login + password (generated, not printed)"}, then apply ${grants.length} grants:`);
    grants.forEach((g) => console.log("     " + g.replace(/\s+/g, " ")));
    console.log("[F] PREVIEW only — no role, no grants, no env file, DATABASE_URL untouched. Re-run with --execute.");
    await admin.end();
    return;
  }

  if (MODE === "revoke") {
    await admin.query(`drop role if exists ${ROLE}`);
    console.log(`[F] dropped role ${ROLE} (reversal). postgres + app untouched.`);
    try { fs.rmSync(APP_ENV, { force: true }); } catch {}
    await admin.end();
    return;
  }

  let appUrl;
  if (MODE === "execute") {
    if (exists) {
      console.log(`[F] role already exists — re-applying grants (idempotent); password NOT changed.`);
      for (const g of grants) await admin.query(g);
      appUrl = readAppEnv(); // reuse the stored cred
    } else {
      const password = crypto.randomBytes(24).toString("base64url"); // strong, url/shell-safe
      await admin.query(`create role ${ROLE} login password '${password.replace(/'/g, "''")}'`);
      for (const g of grants) await admin.query(g);
      console.log(`[F] created role ${ROLE} + applied ${grants.length} grants (as owner postgres). Password generated, NOT printed.`);
      appUrl = buildAppUrl(process.env.DATABASE_URL, password);
      fs.writeFileSync(APP_ENV, `# gitignored — PROD expressline_app runtime cred (for the FUTURE DATABASE_URL switch).\n# NOT active: the app still runs as postgres until the switch step. Never commit / never echo.\nEXPRESSLINE_APP_URL=${appUrl}\n`, { mode: 0o600 });
      console.log(`[F] wrote runtime cred to gitignored ${path.basename(APP_ENV)} (NOT committed, NOT printed).`);
    }
  } else {
    appUrl = readAppEnv();
  }

  // ---- HARD GATE: connect AS expressline_app and prove it ----
  console.log(`\n[F] HARD GATE — connecting AS ${ROLE} (pooler) to verify:`);
  const appPool = new Pool(poolConfigFor(appUrl));
  const { pass, lines } = await verifyAppRole({ appPool, adminPool: admin, schema, role: ROLE, tenantTables: TENANT_TABLES });
  lines.forEach((l) => console.log(l));
  await appPool.end();

  // confirm we did NOT touch postgres or the runtime URL
  const pgUntouched = (await admin.query(`select rolname from pg_roles where rolname='postgres'`)).rowCount === 1;
  console.log(`\n[F] postgres role still present + untouched: ${pgUntouched} | Railway DATABASE_URL: NOT CHANGED (app still runs as postgres)`);
  console.log(`[F] HARD GATE: ${pass ? "PASS ✅ — expressline_app is sufficient, tight, and isolated" : "FAIL ❌ — see above; role NOT ready"}`);
  await admin.end();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error("[F] ERROR:", e.message); process.exit(1); });
