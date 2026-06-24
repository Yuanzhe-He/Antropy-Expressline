// Sandbox connection helper for the blob→relational migration. Loads the
// gitignored .env.sandbox (NOT the prod .env) so every relational script targets
// the throwaway sandbox project, then HARD-ASSERTS the project ref via
// sandbox-guard before handing back a pool. Every relational script must obtain
// its pool through connectSandbox() so the guard runs first.
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { assertSandbox } = require("../sandbox-guard");

const SANDBOX_ENV_PATH = path.join(__dirname, "../../.env.sandbox");

function loadSandboxEnv() {
  if (!fs.existsSync(SANDBOX_ENV_PATH)) {
    throw new Error(
      "[sandbox] .env.sandbox not found — provision the sandbox project first"
    );
  }
  for (const line of fs.readFileSync(SANDBOX_ENV_PATH, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const i = trimmed.indexOf("=");
    if (i < 0) {
      continue;
    }
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim();
    if (key) {
      process.env[key] = value; // sandbox env always wins over any prod .env
    }
  }
}

// Mirror src/lib/db.js buildPoolConfig SSL handling: strip sslmode (newer pg
// parses 'require' as 'verify-full', which rejects Supabase's chain) and set
// rejectUnauthorized:false explicitly.
function sandboxPoolConfig() {
  if (!process.env.DATABASE_URL) {
    throw new Error("[sandbox] DATABASE_URL not set after loading .env.sandbox");
  }
  const url = new URL(process.env.DATABASE_URL);
  const max = Number(process.env.DATABASE_POOL_MAX || 5);
  if (url.searchParams.get("sslmode") && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.delete("sslmode");
    return { connectionString: url.toString(), ssl: { rejectUnauthorized: false }, max };
  }
  return { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max };
}

// Load sandbox env, hard-assert the project ref, return { pool, ref, schema }.
function connectSandbox() {
  loadSandboxEnv();
  const ref = assertSandbox(); // throws unless DATABASE_URL points at the sandbox
  const schema = process.env.DATABASE_SCHEMA || "expressline";
  const pool = new Pool(sandboxPoolConfig());
  return { pool, ref, schema };
}

module.exports = { loadSandboxEnv, sandboxPoolConfig, connectSandbox, SANDBOX_ENV_PATH };
