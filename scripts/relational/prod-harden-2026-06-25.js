// Non-destructive schema hardening from the 2026-06-25 DB structure health check
// (docs/specs/20260625_db_structure_health_check_REPORT.md, findings M1 + index gap m3).
//
// SCOPE: only ADD constraints/indexes to `expressline` tables. No ALTER TYPE, no DROP
// (revert excepted), no data change. Every statement is schema-qualified to a hardcoded
// expressline table — joyas/punas are never referenced. assertProd-gated via connectProdAdmin.
//
// MODES:
//   (default)   verify only — READ-ONLY checks; prints what WOULD be applied. No writes.
//   --apply     verify first; ONLY if clean, apply (CONCURRENTLY indexes + VALID CHECKs).
//   --revert    drop the constraints + indexes this script adds (emergency rollback).
//
// What it adds:
//   M1  7 non-negativity CHECKs on money/rate COLUMNS (domain-universal: a rate/price/
//       charge is never < 0). jsonb rate cells (group_rates/vehicle_prices/burreo/pairs)
//       can't take a column CHECK — they stay an app-layer validation TODO (reported, not
//       enforced here).
//   m3  3 indexes on FK columns that lack a supporting index (origin_id, the trailing
//       column of two composite-PK join tables).
//
// Idempotent: indexes use IF NOT EXISTS; CHECKs are guarded by a pg_constraint existence
// probe. The SAME constraints/indexes are also added idempotently in
// src/lib/db/relational-repo.js#buildSchemaDDL, so a redeploy / fresh schema converges to
// the same shape (this script just applies them to live prod without waiting for a deploy).
const { connectProdAdmin } = require("./prod-env");

const SCHEMA_QUALIFIED = (schema, name) => `"${schema}"."${name}"`;

// [table, constraint_name, check_predicate, column_for_negative_probe]
const CHECKS = [
  ["carrier_local_charges", "carrier_local_charges_tax_rate_nonneg", "tax_rate >= 0", "tax_rate"],
  ["terminal_charges", "terminal_charges_tax_rate_nonneg", "tax_rate >= 0", "tax_rate"],
  ["terminal_charges", "terminal_charges_amount_nonneg", "amount >= 0", "amount"],
  ["yard_charges", "yard_charges_tax_rate_nonneg", "tax_rate >= 0", "tax_rate"],
  ["yard_charges", "yard_charges_amount_nonneg", "amount >= 0", "amount"],
  ["inland_rate_entries", "inland_rate_entries_sencillo_nonneg", "sencillo >= 0", "sencillo"],
  ["inland_rate_entries", "inland_rate_entries_full_nonneg", '"full" >= 0', '"full"'],
];

// [index_name, table, "(cols)"]
const INDEXES = [
  ["inland_rate_entries_origin_idx", "inland_rate_entries", "(origin_id)"],
  ["yard_carriers_carrier_idx", "yard_carriers", "(carrier_id)"],
  ["yard_ports_port_idx", "yard_ports", "(port_id)"],
];

// jsonb columns that carry rate/price numbers — scanned (informational) for any negative
// numeric leaf; these cannot take a column CHECK (app-layer validation TODO).
const JSONB_MONEY = [
  ["carrier_local_charges", "group_rates"],
  ["terminal_charges", "group_rates"],
  ["yard_charges", "group_rates"],
  ["inland_rate_entries", "vehicle_prices"],
  ["inland_rate_entries", "burreo"],
  ["exchange_rates", "pairs"],
];

async function verify(pool, schema) {
  console.log("## VERIFY (read-only)\n");
  let blocking = 0;

  console.log("### A. column-level negatives (would BLOCK the M1 CHECKs)");
  for (const [t, , , col] of CHECKS) {
    const r = await pool.query(`select count(*)::int n from ${SCHEMA_QUALIFIED(schema, t)} where ${col} < 0`);
    const n = r.rows[0].n;
    if (n > 0) blocking += n;
    console.log(`  ${(t + "." + col).padEnd(40)} negatives=${n} ${n === 0 ? "✅" : "🔴 BLOCKS"}`);
  }

  console.log("\n### B. jsonb rate-cell negatives (informational — app-layer TODO, not CHECK-able)");
  for (const [t, col] of JSONB_MONEY) {
    const r = await pool.query(
      `select count(*)::int n from ${SCHEMA_QUALIFIED(schema, t)} where jsonb_path_exists(${col}, '$.** ? (@ < 0)')`
    );
    console.log(`  ${(t + "." + col).padEnd(40)} rows_with_negative_number=${r.rows[0].n}`);
  }

  console.log("\n### C. FK orphan check (every FK child must have a parent)");
  const FK = [
    ["carrier_local_charges", "carrier_id", "carriers", "id"],
    ["customs_terminals", "port_id", "customs_ports", "id"],
    ["terminal_charges", "terminal_id", "customs_terminals", "id"],
    ["yard_charges", "yard_id", "customs_yards", "id"],
    ["yard_ports", "yard_id", "customs_yards", "id"],
    ["yard_ports", "port_id", "customs_ports", "id"],
    ["yard_carriers", "yard_id", "customs_yards", "id"],
    ["yard_carriers", "carrier_id", "carriers", "id"],
    ["inland_rate_entries", "destination_id", "inland_destinations", "id"],
    ["inland_rate_entries", "origin_id", "inland_origins", "id"],
    ["inland_route_cache", "destination_id", "inland_destinations", "id"],
    ["inland_route_cache", "origin_id", "inland_origins", "id"],
  ];
  let orphans = 0;
  for (const [ct, cc, pt, pc] of FK) {
    const r = await pool.query(
      `select count(*)::int n from ${SCHEMA_QUALIFIED(schema, ct)} c
        where c.${cc} is not null
          and not exists (select 1 from ${SCHEMA_QUALIFIED(schema, pt)} p where p.${pc} = c.${cc})`
    );
    if (r.rows[0].n > 0) { orphans += r.rows[0].n; console.log(`  🔴 ${ct}.${cc} -> ${pt}.${pc}: ${r.rows[0].n} orphan(s)`); }
  }
  console.log(`  orphans across all 12 FKs: ${orphans} ${orphans === 0 ? "✅ (all FK-enforced)" : "🔴"}`);

  console.log("\n### D. enum / natural-key state (informational — feeds DECISIONS, not applied here)");
  const mk = await pool.query(`select string_agg(distinct module_key, ', ' order by module_key) v from ${SCHEMA_QUALIFIED(schema, "module_settings")}`);
  console.log(`  module_settings.module_key distinct: ${mk.rows[0].v}`);
  const rg = await pool.query(`select string_agg(distinct rate_group, ', ' order by rate_group) v from ${SCHEMA_QUALIFIED(schema, "container_types")}`);
  console.log(`  container_types.rate_group distinct: ${rg.rows[0].v}`);
  for (const [t, c] of [["carriers", "name"], ["customs_ports", "name"], ["customs_yards", "name"], ["inland_destinations", "name"], ["inland_origins", "name"]]) {
    const r = await pool.query(`select count(*)::int total, count(distinct ${c})::int distinct_v from ${SCHEMA_QUALIFIED(schema, t)}`);
    const { total, distinct_v } = r.rows[0];
    console.log(`  ${(t + "." + c).padEnd(30)} ${distinct_v}/${total} distinct ${distinct_v === total ? "(currently unique)" : "⚠ HAS DUPLICATES"}`);
  }

  console.log("\n### E. index presence (the 3 to add)");
  for (const [name] of INDEXES) {
    const r = await pool.query(`select count(*)::int n from pg_indexes where schemaname=$1 and indexname=$2`, [schema, name]);
    console.log(`  ${name.padEnd(36)} ${r.rows[0].n ? "already present ✅" : "MISSING → will add"}`);
  }

  console.log(`\n>>> VERIFY RESULT: ${blocking === 0 && orphans === 0 ? "CLEAN — safe to --apply ✅" : "BLOCKED 🔴 (negatives/orphans present)"}\n`);
  return blocking === 0 && orphans === 0;
}

async function constraintExists(pool, schema, name, table) {
  const r = await pool.query(
    `select 1 from pg_constraint where conname=$1 and conrelid = ($2 || '.' || $3)::regclass`,
    [name, schema, table]
  );
  return r.rowCount > 0;
}

async function apply(pool, schema) {
  const clean = await verify(pool, schema);
  if (!clean) {
    console.log("REFUSING to apply — verify found blocking negatives/orphans. Fix data first.");
    process.exitCode = 1;
    return;
  }
  console.log("## APPLY (non-destructive ADD only)\n");
  for (const [name, table, cols] of INDEXES) {
    // CONCURRENTLY (no table lock); runs in autocommit (pool.query is not in a txn).
    await pool.query(`create index concurrently if not exists ${name} on ${SCHEMA_QUALIFIED(schema, table)} ${cols}`);
    console.log(`  [index]  ${name} ✅`);
  }
  for (const [table, name, pred] of CHECKS) {
    if (await constraintExists(pool, schema, name, table)) {
      console.log(`  [check]  ${name} already present — skip`);
      continue;
    }
    await pool.query(`alter table ${SCHEMA_QUALIFIED(schema, table)} add constraint ${name} check (${pred})`);
    console.log(`  [check]  ${name} ✅  (${pred})`);
  }
  console.log("\n## POST-APPLY confirm");
  const idx = await pool.query(`select count(*)::int n from pg_indexes where schemaname=$1 and indexname = any($2)`, [schema, INDEXES.map((i) => i[0])]);
  const chk = await pool.query(`select count(*)::int n from pg_constraint where conname = any($1)`, [CHECKS.map((c) => c[1])]);
  console.log(`  indexes present: ${idx.rows[0].n}/${INDEXES.length} | checks present: ${chk.rows[0].n}/${CHECKS.length}`);
}

async function revert(pool, schema) {
  console.log("## REVERT (drop the constraints + indexes this script added)\n");
  for (const [table, name] of CHECKS) {
    await pool.query(`alter table ${SCHEMA_QUALIFIED(schema, table)} drop constraint if exists ${name}`);
    console.log(`  dropped check ${name}`);
  }
  for (const [name] of INDEXES) {
    await pool.query(`drop index concurrently if exists ${SCHEMA_QUALIFIED(schema, name)}`);
    console.log(`  dropped index ${name}`);
  }
  console.log("\n  reverted. (Full revert also: git-revert the buildSchemaDDL hardening commit.)");
}

(async () => {
  const mode = process.argv.includes("--apply") ? "apply" : process.argv.includes("--revert") ? "revert" : "verify";
  const { pool, ref, schema } = connectProdAdmin(); // asserts ref == prod
  console.log(`### prod-harden-2026-06-25 — ref=${ref} schema=${schema} mode=${mode}\n`);
  try {
    if (mode === "apply") await apply(pool, schema);
    else if (mode === "revert") await revert(pool, schema);
    else await verify(pool, schema);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error("HARDEN ERROR:", e.message); process.exit(1); });
