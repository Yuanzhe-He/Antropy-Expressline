// Shared relational data access (DDL + idempotent I/O) for the blob→relational
// migration. ONE implementation used by: the sandbox scripts, the store facade
// (relational/dual modes), and the prod cutover — so what is parity-verified on
// the sandbox is byte-for-byte the same code that runs against prod.
//
// All SQL is schema-qualified; PROJECT-level isolation (which Supabase project)
// is enforced separately (sandbox-guard for the sandbox; a restricted role for
// prod). Callers pass a pg Pool/Client and the schema name.
const { TABLE_META, INSERT_ORDER } = require("./relational-map");

function q(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

const SHIPPING_KEY = "shipping-data";

// ---- DDL (idempotent; mirrors docs/specs/20260621_blob_to_relational_redesign §B′) ----
//
// SCHEMA TRUTH — TWO VIEWS, ONE SCHEMA (must stay in sync):
//   1. buildSchemaDDL (here)            — the PHYSICAL schema: column types, NOT NULL,
//                                         defaults, PK/FK/UNIQUE/CHECK, indexes.
//   2. TABLE_META (./relational-map.js) — the LOGICAL projection: per-table column NAME
//                                         list + which columns are jsonb + PK columns,
//                                         used to generate upsert/read SQL.
// They are deliberately NOT merged into a single spec (DDL has nuance — composite PKs,
// CHECK predicates, the quoted "full" column, the `add column if not exists` for
// carriers.extra — that a generated DDL would obscure). Adding/removing/renaming a column
// REQUIRES editing BOTH: the DDL statement here AND the matching TABLE_META.cols/jsonb
// entry — otherwise upsert/read silently drops the column. The GUARD against drift is the
// round-trip + parity gates (scripts/relational/parity.js, audit-relational-roundtrip-test),
// which fail loudly when the two views disagree. Keep them in CI.
function buildSchemaDDL(schemaName) {
  const s = q(schemaName);
  return [
    `create schema if not exists ${s}`,
    `create table if not exists ${s}.exchange_rates (
       id smallint primary key default 1 check (id = 1),
       provider text, docs_url text,
       as_of_date text, last_checked_at text, last_error text,
       default_quote_currency text not null default 'MXN',
       pairs jsonb not null default '[]'::jsonb,
       updated_at timestamptz not null default now()
     )`,
    `create table if not exists ${s}.carriers (
       id text primary key, name text not null, code text, rfc text,
       notes_extra jsonb not null default '{}'::jsonb,
       -- jsonb (not text): the customs-mirror note is usually a string but some
       -- carriers carry an OBJECT (handover-style {sourceSheet,code,rfc} copied at
       -- mirror creation). text would stringify the object to "[object Object]"
       -- = data loss (caught by the real-prod-data dry-run, 2026-06-23).
       customs_note jsonb,
       active boolean not null default true,
       invoice_to_consignee_only boolean not null default false,
       demurrage_cutoff_handled_by text,
       sort_order integer not null default 0,
       container_groups jsonb not null default '[]'::jsonb,
       demurrage jsonb not null default '{}'::jsonb,
       guarantee jsonb not null default '{}'::jsonb,
       terminal_mix jsonb not null default '[]'::jsonb,
       quote_defaults jsonb not null default '{}'::jsonb,
       extra jsonb not null default '{}'::jsonb,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
    `alter table ${s}.carriers add column if not exists extra jsonb not null default '{}'::jsonb`,
    `create table if not exists ${s}.carrier_local_charges (
       id text primary key,
       carrier_id text not null references ${s}.carriers(id) on delete cascade,
       concept text not null, note text,
       tax_rate numeric(8,4) not null default 0,
       group_rates jsonb not null default '{}'::jsonb,
       bl_rate jsonb, sort_order integer not null default 0
     )`,
    `create index if not exists carrier_local_charges_carrier_idx on ${s}.carrier_local_charges (carrier_id)`,
    `create table if not exists ${s}.container_types (
       key text primary key, label text not null, rate_group text not null,
       sort_order integer not null default 0
     )`,
    `create table if not exists ${s}.customs_ports (
       id text primary key, name text not null, note text,
       sort_order integer not null default 0,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
    `create table if not exists ${s}.customs_terminals (
       id text primary key,
       port_id text not null references ${s}.customs_ports(id) on delete cascade,
       name text not null, note text, sort_order integer not null default 0,
       storage_config jsonb not null default '{}'::jsonb,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
    `create index if not exists customs_terminals_port_idx on ${s}.customs_terminals (port_id)`,
    `create table if not exists ${s}.terminal_charges (
       id text primary key,
       terminal_id text not null references ${s}.customs_terminals(id) on delete cascade,
       concept text not null, note text,
       tax_rate numeric(8,4) not null default 0,
       group_rates jsonb not null default '{}'::jsonb,
       basis text not null default 'per_occurrence' check (basis in ('per_day','per_occurrence')),
       required boolean not null default false,
       amount numeric(14,4), amount_currency text default 'MXN',
       sort_order integer not null default 0
     )`,
    `create index if not exists terminal_charges_terminal_idx on ${s}.terminal_charges (terminal_id)`,
    `create table if not exists ${s}.customs_yards (
       id text primary key, name text not null, note text,
       sort_order integer not null default 0,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
    `create table if not exists ${s}.yard_charges (
       id text primary key,
       yard_id text not null references ${s}.customs_yards(id) on delete cascade,
       kind text not null check (kind in ('dropoff','customs')),
       concept text not null, note text,
       tax_rate numeric(8,4) not null default 0,
       group_rates jsonb not null default '{}'::jsonb,
       basis text not null default 'per_occurrence' check (basis in ('per_day','per_occurrence')),
       required boolean not null default false,
       amount numeric(14,4), amount_currency text default 'MXN',
       sort_order integer not null default 0
     )`,
    `create index if not exists yard_charges_yard_idx on ${s}.yard_charges (yard_id)`,
    `create table if not exists ${s}.yard_ports (
       yard_id text references ${s}.customs_yards(id) on delete cascade,
       port_id text references ${s}.customs_ports(id) on delete cascade,
       seq integer not null default 0, primary key (yard_id, port_id)
     )`,
    `create table if not exists ${s}.yard_carriers (
       yard_id text references ${s}.customs_yards(id) on delete cascade,
       carrier_id text references ${s}.carriers(id) on delete cascade,
       seq integer not null default 0, primary key (yard_id, carrier_id)
     )`,
    `create table if not exists ${s}.inland_origins (
       id text primary key, name text not null,
       lat double precision, lng double precision,
       sort_order integer not null default 0
     )`,
    `create table if not exists ${s}.inland_destinations (
       id text primary key, name text not null, name_zh text, name_es text, state text,
       lat double precision, lng double precision,
       coord_source text, needs_review boolean not null default false,
       image_urls jsonb not null default '[]'::jsonb,
       precise_points jsonb not null default '[]'::jsonb,
       enabled boolean not null default true, note text,
       sort_order integer not null default 0,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
    `create table if not exists ${s}.inland_rate_entries (
       id text primary key,
       origin_id text references ${s}.inland_origins(id),
       destination_id text not null references ${s}.inland_destinations(id) on delete cascade,
       proveedor text, dup_index integer not null default 1,
       cliente text, codigo_cw text, commodity text,
       sencillo numeric(14,4), "full" numeric(14,4),
       burreo jsonb, vehicle_prices jsonb not null default '{}'::jsonb,
       currency text not null default 'MXN',
       enabled boolean not null default true, note text,
       extras jsonb not null default '{}'::jsonb,
       sort_order integer not null default 0
     )`,
    `create index if not exists inland_rate_entries_destination_idx on ${s}.inland_rate_entries (destination_id)`,
    `create table if not exists ${s}.inland_route_cache (
       id text primary key,
       origin_id text references ${s}.inland_origins(id),
       destination_id text not null references ${s}.inland_destinations(id) on delete cascade,
       target_type text not null default 'destination' check (target_type in ('destination','precisePoint')),
       target_id text, encoded_polyline text,
       distance_km numeric, duration_min numeric,
       via_cities jsonb not null default '[]'::jsonb,
       engine text default 'osrm', fetched_at text,
       stale boolean not null default false, has_ferry boolean not null default false,
       manual_override jsonb, sort_order integer not null default 0,
       unique (origin_id, destination_id, target_type, target_id)
     )`,
    `create index if not exists inland_route_cache_destination_idx on ${s}.inland_route_cache (destination_id)`,
    `create table if not exists ${s}.quote_drafts (
       id text primary key, number text, date text,
       header jsonb not null default '{}'::jsonb, quote_mode text,
       line_items jsonb not null default '[]'::jsonb,
       note_ids jsonb not null default '[]'::jsonb,
       language text, created_at text, updated_at text,
       sort_order integer not null default 0
     )`,
    `create table if not exists ${s}.quote_notes (
       id text primary key, en text, es text, zh text,
       sort_order integer not null default 0
     )`,
    `create table if not exists ${s}.module_settings (
       module_key text primary key,
       settings jsonb not null default '{}'::jsonb,
       tax_rate_presets jsonb not null default '[]'::jsonb
     )`,
  ].concat(buildHardeningDDL(schemaName));
}

// 2026-06-25 non-destructive hardening (DB structure health check M1 + index gap m3).
// Idempotent, so a redeploy / fresh schema converges to the SAME shape that
// scripts/relational/prod-harden-2026-06-25.js applied to live prod. Indexes use
// IF NOT EXISTS; CHECKs are guarded by a pg_constraint existence probe (Postgres has no
// ADD CONSTRAINT IF NOT EXISTS). These run inside the ensureRelationalSchema transaction,
// so non-concurrent CREATE INDEX is fine (the entity tables are tiny). A negative
// rate/price/charge can never be written through the app, so the CHECKs never break
// startup on clean data; they are belt-and-suspenders for direct/admin writes.
function buildHardeningDDL(schemaName) {
  const s = q(schemaName);
  // [table, constraint_name, predicate] — money/rate columns are never legitimately < 0.
  const checks = [
    ["carrier_local_charges", "carrier_local_charges_tax_rate_nonneg", "tax_rate >= 0"],
    ["terminal_charges", "terminal_charges_tax_rate_nonneg", "tax_rate >= 0"],
    ["terminal_charges", "terminal_charges_amount_nonneg", "amount >= 0"],
    ["yard_charges", "yard_charges_tax_rate_nonneg", "tax_rate >= 0"],
    ["yard_charges", "yard_charges_amount_nonneg", "amount >= 0"],
    ["inland_rate_entries", "inland_rate_entries_sencillo_nonneg", "sencillo >= 0"],
    ["inland_rate_entries", "inland_rate_entries_full_nonneg", '"full" >= 0'],
  ];
  // [index_name, table, "(cols)"] — FK columns lacking a supporting index.
  const indexes = [
    ["inland_rate_entries_origin_idx", "inland_rate_entries", "(origin_id)"],
    ["yard_carriers_carrier_idx", "yard_carriers", "(carrier_id)"],
    ["yard_ports_port_idx", "yard_ports", "(port_id)"],
  ];
  const out = indexes.map(
    ([name, table, cols]) => `create index if not exists ${name} on ${s}.${q(table)} ${cols}`
  );
  for (const [table, name, pred] of checks) {
    out.push(
      `do $$ begin
         if not exists (
           select 1 from pg_constraint con
             join pg_class cl on cl.oid = con.conrelid
             join pg_namespace n on n.oid = cl.relnamespace
           where n.nspname = '${schemaName}' and cl.relname = '${table}' and con.conname = '${name}'
         ) then
           alter table ${s}.${q(table)} add constraint ${name} check (${pred});
         end if;
       end $$`
    );
  }
  return out;
}

const RELATIONAL_TABLES = Object.freeze([...INSERT_ORDER]);

function buildDropDDL(schemaName) {
  const s = q(schemaName);
  return RELATIONAL_TABLES.map((table) => `drop table if exists ${s}.${q(table)} cascade`);
}

// app_state base table (migration source + rollback fallback).
async function ensureBaseTables(client, schema) {
  const s = q(schema);
  await client.query(`create schema if not exists ${s}`);
  await client.query(`create table if not exists ${s}.app_state (
      key text primary key, payload jsonb not null, revision integer not null default 1,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
}

async function ensureRelationalSchema(client, schema) {
  for (const stmt of buildSchemaDDL(schema)) {
    await client.query(stmt);
  }
}

// ---- blob (app_state) read/write -------------------------------------------
async function readBlob(db, schema, key = SHIPPING_KEY) {
  const r = await db.query(`select payload from ${q(schema)}.app_state where key = $1`, [key]);
  return r.rows[0]?.payload || null;
}

async function writeBlob(db, schema, payload, key = SHIPPING_KEY) {
  await db.query(
    `insert into ${q(schema)}.app_state as st (key, payload, revision)
       values ($1, $2::jsonb, 1)
       on conflict (key) do update set payload = excluded.payload, revision = st.revision + 1, updated_at = now()`,
    [key, JSON.stringify(payload)]
  );
}

// ---- table upsert / read (TABLE_META-driven) -------------------------------
function buildUpsertSql(schema, table) {
  const meta = TABLE_META[table];
  const jsonb = new Set(meta.jsonb);
  const colSql = meta.cols.map(q).join(", ");
  const placeholders = meta.cols.map((c, i) => (jsonb.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ");
  const updateCols = meta.cols.filter((c) => !meta.pk.includes(c));
  const setClause = updateCols.length
    ? `do update set ${updateCols.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`
    : "do nothing";
  return `insert into ${q(schema)}.${q(table)} (${colSql}) values (${placeholders})
            on conflict (${meta.pk.map(q).join(", ")}) ${setClause}`;
}

function rowParams(meta, row) {
  const jsonb = new Set(meta.jsonb);
  return meta.cols.map((c) =>
    jsonb.has(c) ? JSON.stringify(row[c] ?? null) : row[c] === undefined ? null : row[c]
  );
}

async function upsertRows(client, schema, table, rows) {
  const meta = TABLE_META[table];
  const sql = buildUpsertSql(schema, table);
  for (const row of rows) {
    await client.query(sql, rowParams(meta, row));
  }
}

async function upsertAllTables(client, schema, tables) {
  const counts = {};
  for (const table of INSERT_ORDER) {
    const rows = tables[table] || [];
    await upsertRows(client, schema, table, rows);
    counts[table] = rows.length;
  }
  return counts;
}

async function readAllTables(db, schema) {
  const out = {};
  for (const table of INSERT_ORDER) {
    const r = await db.query(`select * from ${q(schema)}.${q(table)}`);
    out[table] = r.rows;
  }
  return out;
}

async function tableCounts(db, schema) {
  const out = {};
  for (const table of INSERT_ORDER) {
    const r = await db.query(`select count(*)::int n from ${q(schema)}.${q(table)}`);
    out[table] = r.rows[0].n;
  }
  return out;
}

// ---- canonical (key-order-insensitive) compare for parity / shadow-diff ----
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

module.exports = {
  q,
  SHIPPING_KEY,
  buildSchemaDDL,
  buildDropDDL,
  RELATIONAL_TABLES,
  ensureBaseTables,
  ensureRelationalSchema,
  readBlob,
  writeBlob,
  buildUpsertSql,
  upsertRows,
  upsertAllTables,
  readAllTables,
  tableCounts,
  canonicalize,
  canonicalJson,
};
