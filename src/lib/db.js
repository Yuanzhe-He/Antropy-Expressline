const { Pool } = require("pg");
const { loadLocalEnv } = require("./env");

loadLocalEnv();

const DEFAULT_DATABASE_SCHEMA = "expressline";

let pool = null;
let schemaReady = false;

function getDatabaseSchema() {
  const schema = process.env.DATABASE_SCHEMA || DEFAULT_DATABASE_SCHEMA;
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(
      "DATABASE_SCHEMA must use lowercase letters, numbers, and underscores only"
    );
  }
  return schema;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function shouldUseDatabase() {
  if (process.env.STORAGE_DRIVER === "json") {
    return false;
  }
  if (process.env.STORAGE_DRIVER === "postgres") {
    return true;
  }
  return Boolean(process.env.DATABASE_URL);
}

function buildPoolConfig() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Postgres storage");
  }

  const url = new URL(process.env.DATABASE_URL);
  if (
    url.searchParams.get("sslmode") &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    url.searchParams.delete("sslmode");
    return {
      connectionString: url.toString(),
      max: Number(process.env.DATABASE_POOL_MAX || 5),
      ssl: { rejectUnauthorized: false },
    };
  }

  return {
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX || 5),
  };
}

function getPool() {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
  }
  return pool;
}

async function migrateDatabase() {
  const schema = getDatabaseSchema();
  const quotedSchema = quoteIdentifier(schema);
  const client = await getPool().connect();

  try {
    await client.query("begin");
    await client.query(`create schema if not exists ${quotedSchema}`);
    await client.query(`
      create table if not exists ${quotedSchema}.app_state (
        key text primary key,
        payload jsonb not null,
        revision integer not null default 1,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await client.query(`
      create table if not exists ${quotedSchema}.audit_logs (
        id bigserial primary key,
        actor text,
        action text not null,
        target text,
        before_payload jsonb,
        after_payload jsonb,
        created_at timestamptz not null default now()
      )
    `);
    await client.query(`
      create table if not exists ${quotedSchema}.quote_snapshots (
        id bigserial primary key,
        module_key text not null,
        business_nature text,
        input_payload jsonb not null,
        result_payload jsonb not null,
        created_at timestamptz not null default now()
      )
    `);
    await client.query("commit");
    schemaReady = true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureDatabase() {
  if (!schemaReady) {
    await migrateDatabase();
  }
}

async function getAppState(key) {
  await ensureDatabase();
  const schema = quoteIdentifier(getDatabaseSchema());
  const result = await getPool().query(
    `select payload from ${schema}.app_state where key = $1`,
    [key]
  );
  return result.rows[0]?.payload || null;
}

async function saveAppState(key, payload) {
  await ensureDatabase();
  const schema = quoteIdentifier(getDatabaseSchema());
  await getPool().query(
    `
      insert into ${schema}.app_state as state (key, payload, revision)
      values ($1, $2::jsonb, 1)
      on conflict (key) do update
        set payload = excluded.payload,
            revision = state.revision + 1,
            updated_at = now()
    `,
    [key, JSON.stringify(payload)]
  );
}

// Insert an immutable audit snapshot of a generated quote. DB-only: callers
// must guard with shouldUseDatabase() and skip in JSON-fallback mode. The
// quote_snapshots table is created in migrateDatabase() (zero extra migration).
// Targeted update of a single top-level app_state key (e.g. exchangeRates) via
// jsonb_set, so a frequent writer (the FX refresh) cannot clobber concurrent
// edits to OTHER parts of the same payload. Returns rowCount.
async function patchAppStateField(key, field, value) {
  await ensureDatabase();
  const schema = quoteIdentifier(getDatabaseSchema());
  const result = await getPool().query(
    `
      update ${schema}.app_state
        set payload = jsonb_set(coalesce(payload, '{}'::jsonb), $2::text[], $3::jsonb, true),
            revision = revision + 1,
            updated_at = now()
      where key = $1
    `,
    [key, `{${field}}`, JSON.stringify(value)]
  );
  return result.rowCount;
}

async function insertQuoteSnapshot({ moduleKey = "quote", businessNature = null, input, result }) {
  await ensureDatabase();
  const schema = quoteIdentifier(getDatabaseSchema());
  const { rows } = await getPool().query(
    `
      insert into ${schema}.quote_snapshots
        (module_key, business_nature, input_payload, result_payload)
      values ($1, $2, $3::jsonb, $4::jsonb)
      returning id, created_at
    `,
    [moduleKey, businessNature, JSON.stringify(input ?? {}), JSON.stringify(result ?? {})]
  );
  return rows[0] || null;
}

async function listQuoteSnapshots(limit = 50) {
  await ensureDatabase();
  const schema = quoteIdentifier(getDatabaseSchema());
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 50)));
  const { rows } = await getPool().query(
    `
      select id, module_key, business_nature, input_payload, result_payload, created_at
      from ${schema}.quote_snapshots
      order by created_at desc
      limit $1
    `,
    [safeLimit]
  );
  return rows;
}

async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
    schemaReady = false;
  }
}

module.exports = {
  closeDatabase,
  getAppState,
  getDatabaseSchema,
  insertQuoteSnapshot,
  listQuoteSnapshots,
  migrateDatabase,
  patchAppStateField,
  saveAppState,
  shouldUseDatabase,
};
