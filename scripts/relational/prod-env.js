// Connection helpers for the PROD blob→relational cutover (Phases 0-4). Two roles:
//   connectProdAdmin()    — the existing broad-privilege prod cred (postgres) from .env.
//                           Used ONLY in Phase 0 (scoped read-only backup) and Phase 1
//                           (create the restricted role). NEVER used for migration writes.
//   connectProdMigrator() — the restricted `expressline_migrator` role (Phase 1 output),
//                           creds in gitignored .env.prod-migrator. ALL Phase 2-4 SQL goes
//                           through it, so schema isolation is physically enforced.
// Both assert ref == prod before returning a pool. SSL handling mirrors src/lib/db.js.
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { loadLocalEnv } = require("../../src/lib/env");
const { assertProd, PROD_REF } = require("./prod-guard");

const MIGRATOR_ENV = path.join(__dirname, "../../.env.prod-migrator");

function poolConfigFor(databaseUrl, max = 3) {
  const url = new URL(databaseUrl);
  // Strip sslmode unless uselibpqcompat is present (newer pg parses 'require' as
  // 'verify-full', which rejects Supabase's chain) and set rejectUnauthorized:false.
  if (url.searchParams.get("sslmode") && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.delete("sslmode");
    return { connectionString: url.toString(), ssl: { rejectUnauthorized: false }, max };
  }
  return { connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, max };
}

function connectProdAdmin() {
  loadLocalEnv(); // prod .env -> DATABASE_URL (postgres, broad privilege)
  const url = process.env.DATABASE_URL;
  const ref = assertProd(url); // throws unless ref == prod
  const schema = process.env.DATABASE_SCHEMA || "expressline";
  return { pool: new Pool(poolConfigFor(url)), ref, schema, role: "admin(postgres)" };
}

function loadMigratorEnv() {
  if (!fs.existsSync(MIGRATOR_ENV)) {
    throw new Error("[prod-env] .env.prod-migrator not found — run Phase 1 (create role) first");
  }
  const out = {};
  for (const line of fs.readFileSync(MIGRATOR_ENV, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function connectProdMigrator() {
  const env = loadMigratorEnv();
  const url = env.PROD_MIGRATOR_URL;
  if (!url) throw new Error("[prod-env] PROD_MIGRATOR_URL missing in .env.prod-migrator");
  const ref = assertProd(url); // the migrator URL must ALSO point at prod
  return { pool: new Pool(poolConfigFor(url)), ref, schema: "expressline", role: "expressline_migrator" };
}

module.exports = { connectProdAdmin, connectProdMigrator, poolConfigFor, loadMigratorEnv, MIGRATOR_ENV, PROD_REF };
