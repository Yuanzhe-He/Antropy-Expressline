const { Pool } = require("pg");
// db is now a directory module (src/lib/db/): relational-map + relational-repo are
// co-located db-layer leaves (moved here from lib/store/ to remove the lib/db →
// lib/store reverse edge — see the M4 fix). env + usage-guard are shared bottom
// leaves (the store layer imports them too), so importing them up one level is not
// a layer inversion.
const { loadLocalEnv } = require("../env");
const usageGuard = require("../usage-guard");
const relRepo = require("./relational-repo");
const { decompose, assemble, TABLE_META } = require("./relational-map");

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

// Runtime / least-privilege guard. A cheap, least-priv-SAFE existence check: `to_regclass`
// only needs USAGE on the schema (which the runtime role has) — NOT the owner-only DDL
// privilege that create/alter/index require. When the schema is already built (every prod
// start, and ANY non-owner runtime role like `expressline_app`), the app must NOT run the
// startup schema-ensure (migrateDatabase / buildSchemaDDL) — those are owner-only and would
// fail for a least-privilege role. Only a genuinely fresh DB (table absent) runs the
// ensure-DDL, which is the initial OWNER-driven setup path (a fresh deploy connects as the
// owner, or a migration script builds it). Behavior in the existing postgres/owner mode is
// IDENTICAL: the ensure was already a no-op there (the tables exist), so skipping it has the
// exact same end state — it just no longer issues owner-only DDL the runtime shouldn't run.
async function relationExists(schema, table) {
  try {
    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const r = await getPool().query("select to_regclass($1) as oid", [qualified]);
    return r.rows[0].oid !== null;
  } catch (_error) {
    return false; // any error → fall through to the ensure path (fresh-DB / owner setup)
  }
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
  if (schemaReady) {
    return;
  }
  // Runtime path: the base tables (app_state/audit_logs/quote_snapshots) already exist →
  // SKIP the owner-only migrateDatabase. Only a fresh DB runs it. See relationExists.
  if (await relationExists(getDatabaseSchema(), "app_state")) {
    schemaReady = true;
    return;
  }
  await migrateDatabase();
}

async function getAppState(key) {
  await ensureDatabase();
  // Every getAppState is a DB-penetration read (the read cache lives a layer up
  // in store.js, so cache hits never reach here). Count it for the usage guard.
  usageGuard.recordRead();
  const schema = quoteIdentifier(getDatabaseSchema());
  const result = await getPool().query(
    `select payload from ${schema}.app_state where key = $1`,
    [key]
  );
  return result.rows[0]?.payload || null;
}

async function saveAppState(key, payload) {
  await ensureDatabase();
  usageGuard.recordWrite();
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

// Build a Postgres text[] literal from a jsonb path. Accepts a single field
// name ("exchangeRates") or a nested path array (["modules", "handover"]). Each
// segment is double-quoted and escaped so keys containing commas/braces/quotes
// cannot break out of the array literal.
function buildJsonPathLiteral(field) {
  const segments = Array.isArray(field) ? field : [field];
  const quoted = segments.map(
    (segment) =>
      `"${String(segment).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  );
  return `{${quoted.join(",")}}`;
}

// Targeted update of a single app_state path (e.g. "exchangeRates" or the
// nested ["modules", "handover"]) via jsonb_set, so a frequent writer cannot
// clobber concurrent edits to OTHER parts of the same payload — and so a
// single-field/single-module change does not have to re-serialize and re-ship
// the whole multi-MB blob. Returns rowCount (0 when no row exists yet).
async function patchAppStateField(key, field, value) {
  await ensureDatabase();
  usageGuard.recordWrite();
  const schema = quoteIdentifier(getDatabaseSchema());
  const result = await getPool().query(
    `
      update ${schema}.app_state
        set payload = jsonb_set(coalesce(payload, '{}'::jsonb), $2::text[], $3::jsonb, true),
            revision = revision + 1,
            updated_at = now()
      where key = $1
    `,
    [key, buildJsonPathLiteral(field), JSON.stringify(value)]
  );
  return result.rowCount;
}

// Insert an immutable audit snapshot of a generated quote. DB-only: callers
// must guard with shouldUseDatabase() and skip in JSON-fallback mode. The
// quote_snapshots table is created in migrateDatabase() (zero extra migration).
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

// --- relational storage (STORAGE_MODE=relational|dual) ----------------------
// Shares the same pool + schema as the blob path; project-level isolation is
// orthogonal. ensureRelationalReady() creates the entity tables once (idempotent),
// the analog of ensureDatabase() for the blob path.
let relationalReady = false;

async function ensureRelationalReady() {
  if (relationalReady) {
    return;
  }
  const schema = getDatabaseSchema();
  // Runtime path: the relational entity tables are already built → SKIP the owner-only
  // buildSchemaDDL (create/alter/index). Only a genuinely fresh DB runs the ensure-DDL.
  // See relationExists — this is the switch prerequisite that lets a least-privilege role
  // (expressline_app) start without owner DDL; postgres/owner behavior is unchanged.
  if (await relationExists(schema, "carriers")) {
    relationalReady = true;
    return;
  }
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await relRepo.ensureRelationalSchema(client, schema);
    await client.query("commit");
    relationalReady = true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// Read all entity tables and assemble the shipping-data shape (pre-normalize, to
// match getAppState's raw payload). Returns null when the tables are empty
// (fresh store) so the caller seeds, mirroring getAppState returning null.
async function getShippingTablesAssembled() {
  await ensureRelationalReady();
  // DB-penetration read (the read cache lives a layer up in the store facade).
  usageGuard.recordRead();
  const tables = await relRepo.readAllTables(getPool(), getDatabaseSchema());
  const empty = Object.values(tables).every((rows) => rows.length === 0);
  return empty ? null : assemble(tables);
}

// Full overwrite of all entity tables from a normalized blob (2a behavior;
// per-entity targeted writes arrive in 2b). One transaction.
async function saveShippingTables(normalized) {
  await ensureRelationalReady();
  usageGuard.recordWrite();
  const schema = getDatabaseSchema();
  const tables = decompose(normalized);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await relRepo.upsertAllTables(client, schema, tables);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// Targeted write of ONLY the exchange_rates singleton row (per-entity FX write).
async function saveExchangeRatesTable(exchangeRates) {
  await ensureRelationalReady();
  usageGuard.recordWrite();
  const schema = getDatabaseSchema();
  const erRow = decompose({ exchangeRates, modules: {} }).exchange_rates[0];
  const client = await getPool().connect();
  try {
    await relRepo.upsertRows(client, schema, "exchange_rates", [erRow]);
  } finally {
    client.release();
  }
}

// --- per-entity targeted writes (2b: root-fix concurrent clobber) -----------
// Each writes ONLY its own entity's row(s) in one transaction, so a write to
// entity A can never clobber a concurrent write to entity B (the full-blob /
// full-tables overwrite hazard). sort_order is preserved from the existing row
// (a content edit must not reorder the entity).
async function withTxn(fn) {
  await ensureRelationalReady();
  usageGuard.recordWrite();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client, getDatabaseSchema());
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function preserveSortOrder(client, schema, table, id, row) {
  const ex = await client.query(
    `select sort_order from ${relRepo.q(schema)}.${relRepo.q(table)} where id = $1`,
    [id]
  );
  if (ex.rows[0]) {
    row.sort_order = ex.rows[0].sort_order;
  }
  return row;
}

// Upsert one carrier (carriers row + its carrier_local_charges, replaced atomically).
async function saveCarrierEntity(carrier) {
  const tables = decompose({
    modules: { handover: { shippingLines: [carrier] }, customs: { shippingLines: [] } },
  });
  const row = tables.carriers[0];
  return withTxn(async (client, schema) => {
    // a carrier content edit must keep its customs_note unless explicitly changed
    const ex = await client.query(
      `select sort_order, customs_note from ${relRepo.q(schema)}.carriers where id = $1`,
      [carrier.id]
    );
    if (ex.rows[0]) {
      row.sort_order = ex.rows[0].sort_order;
      if (carrier.customs_note === undefined) {
        row.customs_note = ex.rows[0].customs_note;
      }
    }
    await relRepo.upsertRows(client, schema, "carriers", [row]);
    await client.query(
      `delete from ${relRepo.q(schema)}.carrier_local_charges where carrier_id = $1`,
      [carrier.id]
    );
    await relRepo.upsertRows(client, schema, "carrier_local_charges", tables.carrier_local_charges);
  });
}

// Upsert one customs yard (customs_yards row + its charges + join rows, atomic).
async function saveCustomsYardEntity(yard) {
  const tables = decompose({ modules: { customs: { yards: [yard] } } });
  const row = tables.customs_yards[0];
  return withTxn(async (client, schema) => {
    await preserveSortOrder(client, schema, "customs_yards", yard.id, row);
    await relRepo.upsertRows(client, schema, "customs_yards", [row]);
    for (const [table, fk] of [["yard_charges", "yard_id"], ["yard_ports", "yard_id"], ["yard_carriers", "yard_id"]]) {
      await client.query(`delete from ${relRepo.q(schema)}.${relRepo.q(table)} where ${relRepo.q(fk)} = $1`, [yard.id]);
      await relRepo.upsertRows(client, schema, table, tables[table]);
    }
  });
}

// Upsert one inland rate entry (single row).
async function saveInlandRateEntryEntity(entry) {
  const tables = decompose({ modules: { inland: { rateEntries: [entry] } } });
  const row = tables.inland_rate_entries[0];
  return withTxn(async (client, schema) => {
    await preserveSortOrder(client, schema, "inland_rate_entries", entry.id, row);
    await relRepo.upsertRows(client, schema, "inland_rate_entries", [row]);
  });
}

// Tables OWNED by each business module, parent-before-child (FK-safe). carriers
// live under handover (customs only mirrors them, derived on read); exchange_rates
// and module_settings.__app__ are not module-owned (untouched by a module save).
const MODULE_TABLES = {
  handover: ["container_types", "carriers", "carrier_local_charges"],
  customs: [
    "customs_ports",
    "customs_terminals",
    "terminal_charges",
    "customs_yards",
    "yard_charges",
    "yard_ports",
    "yard_carriers",
  ],
  inland: ["inland_origins", "inland_destinations", "inland_rate_entries", "inland_route_cache"],
  quote: ["quote_drafts", "quote_notes"],
};

// Sync one table to exactly `rows`: delete rows whose PK-tuple isn't in the new
// set (cascades prune their children), then upsert the new set. Works for single
// and composite PKs.
async function syncTable(client, schema, table, rows) {
  const pk = TABLE_META[table].pk;
  if (rows.length === 0) {
    await client.query(`delete from ${relRepo.q(schema)}.${relRepo.q(table)}`);
  } else {
    const tupleCols = pk.map(relRepo.q).join(", ");
    const valuesList = rows
      .map((_, i) => `(${pk.map((_, j) => `$${i * pk.length + j + 1}`).join(", ")})`)
      .join(", ");
    const params = rows.flatMap((r) => pk.map((c) => r[c]));
    await client.query(
      `delete from ${relRepo.q(schema)}.${relRepo.q(table)} where (${tupleCols}) not in (${valuesList})`,
      params
    );
  }
  await relRepo.upsertRows(client, schema, table, rows);
}

// Module-scoped targeted write: persist ONLY the given module's tables from a
// normalized document (other modules + exchange_rates untouched → no cross-module
// clobber). One transaction.
async function saveModuleTables(moduleKey, normalized) {
  const owned = MODULE_TABLES[moduleKey];
  if (!owned) {
    throw new Error(`saveModuleTables: unknown module ${moduleKey}`);
  }
  await ensureRelationalReady();
  usageGuard.recordWrite();
  const schema = getDatabaseSchema();
  const tables = decompose(normalized);
  const settingsRow = tables.module_settings.find((r) => r.module_key === moduleKey);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    for (const table of owned) {
      await syncTable(client, schema, table, tables[table]);
    }
    if (settingsRow) {
      await relRepo.upsertRows(client, schema, "module_settings", [settingsRow]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
    schemaReady = false;
    relationalReady = false;
  }
}

// Cheap "is the relational store populated?" probe (1 row, no payload) for the startup
// sanity warning. Returns false in non-DB mode or on any error (never throws).
async function relationalTablesPopulated() {
  if (!shouldUseDatabase()) {
    return false;
  }
  try {
    const schema = quoteIdentifier(getDatabaseSchema());
    const result = await getPool().query(`select 1 from ${schema}.carriers limit 1`);
    return result.rowCount > 0;
  } catch (error) {
    return false;
  }
}

// Pure: the loud startup warning when DB mode + populated relational tables + a
// STORAGE_MODE that is NOT relational — in that state the app silently reads the
// app_state blob (which may be FROZEN/stale after a cutover) instead of the tables.
// Returns the warning string, or null when the configuration is consistent.
function storageModeStartupWarning({ usingDb, storageMode, tablesPopulated }) {
  const mode = String(storageMode || "blob").toLowerCase();
  if (usingDb && tablesPopulated && mode !== "relational") {
    return (
      `[startup] ⚠ relational tables are POPULATED but STORAGE_MODE=${mode} — the app is ` +
      "reading the app_state blob (which may be FROZEN/stale after a cutover), NOT the tables. " +
      "If the relational cutover is complete, set STORAGE_MODE=relational."
    );
  }
  return null;
}

module.exports = {
  closeDatabase,
  relationalTablesPopulated,
  storageModeStartupWarning,
  ensureRelationalReady,
  getAppState,
  getDatabaseSchema,
  getShippingTablesAssembled,
  insertQuoteSnapshot,
  listQuoteSnapshots,
  migrateDatabase,
  patchAppStateField,
  saveAppState,
  saveCarrierEntity,
  saveCustomsYardEntity,
  saveExchangeRatesTable,
  saveInlandRateEntryEntity,
  saveModuleTables,
  saveShippingTables,
  shouldUseDatabase,
};
