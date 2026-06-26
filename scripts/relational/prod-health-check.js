// PHASE 1 — read-only Supabase health check. Uses ONLY cheap metadata queries
// (pg_stat_statements aggregates, count(*), pg_stat_database) — NEVER pulls the blob or
// full tables, so the measurement itself creates ~no egress. expressline-scoped (filters
// pg_stat_statements to our queries; never reads joyas/punas data).
const { connectProdAdmin } = require("./prod-env");
const { RELATIONAL_TABLES } = require("../../src/lib/db/relational-repo");

const BASELINE = { carriers: 21, customs_yards: 28, inland_destinations: 44, inland_rate_entries: 300, container_types: 20, quote_notes: 5, module_settings: 5 };

(async () => {
  const { pool, ref, schema } = connectProdAdmin();
  console.log(`[health] ref=${ref} (PROD) schema=${schema} — read-only, low-egress\n`);

  // --- pg_stat_statements (query patterns) ---
  const ext = await pool.query(`select extname from pg_extension where extname='pg_stat_statements'`);
  if (ext.rows.length) {
    // detect column naming (PG13+ = total_exec_time/mean_exec_time)
    const cols = (await pool.query(`select column_name from information_schema.columns where table_name='pg_stat_statements'`)).rows.map((r) => r.column_name);
    const totalT = cols.includes("total_exec_time") ? "total_exec_time" : "total_time";
    const meanT = cols.includes("mean_exec_time") ? "mean_exec_time" : "mean_time";
    console.log("[health] === pg_stat_statements — expressline queries by CALLS (top 18) ===");
    const byCalls = await pool.query(
      `select calls, round(${meanT}::numeric,2) mean_ms, round(${totalT}::numeric,0) total_ms, rows,
              regexp_replace(left(query,90),'\\s+',' ','g') q
         from pg_stat_statements
        where query ilike '%expressline.%' and query not ilike '%pg_stat_statements%'
        order by calls desc limit 18`
    );
    for (const r of byCalls.rows) console.log(`  calls=${String(r.calls).padStart(7)} mean=${String(r.mean_ms).padStart(7)}ms rows=${String(r.rows).padStart(8)} | ${r.q}`);
    console.log("\n[health] === expressline queries by total ROWS returned (top 8 — egress proxy) ===");
    const byRows = await pool.query(
      `select calls, rows, round(rows::numeric/nullif(calls,0),1) rows_per_call, regexp_replace(left(query,90),'\\s+',' ','g') q
         from pg_stat_statements where query ilike '%expressline.%' order by rows desc limit 8`
    );
    for (const r of byRows.rows) console.log(`  rows=${String(r.rows).padStart(9)} calls=${String(r.calls).padStart(6)} rows/call=${String(r.rows_per_call).padStart(7)} | ${r.q}`);
  } else {
    console.log("[health] pg_stat_statements NOT installed — relying on /healthz + pg_stat_database.");
  }

  // --- pg_stat_database (DB-level cumulative since last reset) ---
  console.log("\n[health] === pg_stat_database (this DB, cumulative) ===");
  const dbs = await pool.query(
    `select numbackends, xact_commit, tup_returned, tup_fetched, blks_read, blks_hit, stats_reset
       from pg_stat_database where datname = current_database()`
  );
  const s = dbs.rows[0];
  const hitRatio = s.blks_hit && (Number(s.blks_hit) + Number(s.blks_read)) ? (100 * Number(s.blks_hit) / (Number(s.blks_hit) + Number(s.blks_read))).toFixed(2) : "?";
  console.log(`  backends=${s.numbackends} commits=${s.xact_commit} tup_returned=${s.tup_returned} tup_fetched=${s.tup_fetched} cache_hit=${hitRatio}% stats_reset=${s.stats_reset?.toISOString?.() || s.stats_reset}`);

  // --- row-count stability vs cutover baseline (cheap count(*)) ---
  console.log("\n[health] === row counts (18 tables) vs cutover baseline ===");
  let drift = [];
  for (const t of RELATIONAL_TABLES) {
    const n = (await pool.query(`select count(*)::int c from ${schema}."${t}"`)).rows[0].c;
    const base = BASELINE[t];
    const tag = base === undefined ? "" : n === base ? " ✅" : ` ⚠ baseline ${base}`;
    if (base !== undefined && n !== base) drift.push(`${t}: ${n} vs ${base}`);
    if (base !== undefined) console.log(`  ${t.padEnd(22)} ${String(n).padStart(4)}${tag}`);
  }
  console.log(`  baseline drift: ${drift.length ? drift.join("; ") : "NONE — counts stable ✅"}`);

  await pool.end();
})().catch((e) => { console.error("[health] ERROR:", e.message); process.exit(1); });
