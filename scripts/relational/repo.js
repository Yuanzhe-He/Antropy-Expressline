// DB read/write for the relational migration, driven by TABLE_META. All DDL/DML
// is qualified to the configured schema; project-level isolation is enforced by
// sandbox-guard (callers must obtain the pool via connectSandbox()).
const { TABLE_META, INSERT_ORDER } = require("../../src/lib/store/relational-map");

function q(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

const SHIPPING_KEY = "shipping-data";

// app_state base table (mirrors src/lib/db.js migrateDatabase). Holds the blob
// that is the migration source and the rollback fallback.
async function ensureBaseTables(client, schema) {
  const s = q(schema);
  await client.query(`create schema if not exists ${s}`);
  await client.query(`
    create table if not exists ${s}.app_state (
      key text primary key,
      payload jsonb not null,
      revision integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
}

async function readBlob(pool, schema, key = SHIPPING_KEY) {
  const r = await pool.query(
    `select payload from ${q(schema)}.app_state where key = $1`,
    [key]
  );
  return r.rows[0]?.payload || null;
}

async function writeBlob(pool, schema, payload, key = SHIPPING_KEY) {
  await pool.query(
    `insert into ${q(schema)}.app_state as st (key, payload, revision)
       values ($1, $2::jsonb, 1)
       on conflict (key) do update
         set payload = excluded.payload, revision = st.revision + 1, updated_at = now()`,
    [key, JSON.stringify(payload)]
  );
}

function buildUpsertSql(schema, table) {
  const meta = TABLE_META[table];
  const jsonb = new Set(meta.jsonb);
  const colSql = meta.cols.map(q).join(", ");
  const placeholders = meta.cols
    .map((c, i) => (jsonb.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`))
    .join(", ");
  const updateCols = meta.cols.filter((c) => !meta.pk.includes(c));
  const setClause = updateCols.length
    ? `do update set ${updateCols.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`
    : "do nothing";
  return `insert into ${q(schema)}.${q(table)} (${colSql})
            values (${placeholders})
            on conflict (${meta.pk.map(q).join(", ")}) ${setClause}`;
}

// Idempotent upsert of all decomposed rows (parent→child order). Counts rows.
async function upsertAllTables(client, schema, tables) {
  const counts = {};
  for (const table of INSERT_ORDER) {
    const meta = TABLE_META[table];
    const jsonb = new Set(meta.jsonb);
    const sql = buildUpsertSql(schema, table);
    const rows = tables[table] || [];
    for (const row of rows) {
      const params = meta.cols.map((c) =>
        jsonb.has(c)
          ? JSON.stringify(row[c] ?? null)
          : row[c] === undefined
            ? null
            : row[c]
      );
      await client.query(sql, params);
    }
    counts[table] = rows.length;
  }
  return counts;
}

async function readAllTables(pool, schema) {
  const out = {};
  for (const table of INSERT_ORDER) {
    const r = await pool.query(`select * from ${q(schema)}.${q(table)}`);
    out[table] = r.rows;
  }
  return out;
}

async function tableCounts(pool, schema) {
  const out = {};
  for (const table of INSERT_ORDER) {
    const r = await pool.query(`select count(*)::int n from ${q(schema)}.${q(table)}`);
    out[table] = r.rows[0].n;
  }
  return out;
}

// Recursively key-sorted JSON — parity compares DATA, not key order (the
// normalizer spreads ...shippingLine so key order is input-derived & irrelevant).
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
  ensureBaseTables,
  readBlob,
  writeBlob,
  upsertAllTables,
  readAllTables,
  tableCounts,
  canonicalize,
  canonicalJson,
};
