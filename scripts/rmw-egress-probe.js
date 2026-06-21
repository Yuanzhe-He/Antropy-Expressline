// READ-ONLY production diagnostic for the RMW egress storm. Never writes, never
// prints secrets. Reports:
//   - shipping-data blob size (confirms the ~1.6-2.2MB payload behind the egress)
//   - app_state revision + updated_at sampled twice over an interval, so the
//     revision delta = the live write rate (the "is the storm still burning?"
//     check, and the before/after metric for the cache fix).
//
// Usage:  node scripts/rmw-egress-probe.js [intervalSeconds]   (default 60)

const { loadLocalEnv } = require("../src/lib/env");
loadLocalEnv();

const { Pool } = require("pg");

function getDatabaseSchema() {
  const schema = process.env.DATABASE_SCHEMA || "expressline";
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("bad schema");
  return schema;
}

function buildPoolConfig() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const url = new URL(process.env.DATABASE_URL);
  if (url.searchParams.get("sslmode") && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.delete("sslmode");
    return { connectionString: url.toString(), max: 2, ssl: { rejectUnauthorized: false } };
  }
  return { connectionString: process.env.DATABASE_URL, max: 2 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sampleRow(pool, schema) {
  const { rows } = await pool.query(
    `select key, revision, updated_at,
            pg_column_size(payload) as bytes,
            pg_size_pretty(pg_column_size(payload)::bigint) as pretty
       from "${schema}".app_state
      where key = 'shipping-data'`
  );
  return rows[0] || null;
}

// Cumulative count of the app_state read query, from pg_stat_statements. The
// READ path (not the write path) is the egress driver: each read ships the whole
// blob. revision only tracks writes, so we sample this separately. Returns null
// if pg_stat_statements is not reachable over this connection.
async function sampleReadCalls(pool) {
  try {
    const { rows } = await pool.query(
      `select coalesce(sum(calls), 0)::bigint as calls
         from pg_stat_statements
        where query ilike '%app_state%'
          and query ilike '%payload%'
          and query ilike '%select%'`
    );
    return Number(rows[0].calls);
  } catch (err) {
    return null;
  }
}

async function main() {
  const intervalSec = Math.max(0, Number(process.argv[2]) || 60);
  const schema = getDatabaseSchema();
  const pool = new Pool(buildPoolConfig());

  try {
    const a = await sampleRow(pool, schema);
    if (!a) {
      console.log("probe: no shipping-data row found");
      return;
    }
    const reads0 = await sampleReadCalls(pool);
    console.log("=== shipping-data blob ===");
    console.log(`  size      : ${a.pretty} (${a.bytes} bytes)`);
    console.log(`  revision  : ${a.revision}`);
    console.log(`  updated_at: ${a.updated_at.toISOString()}`);
    if (reads0 !== null) console.log(`  read calls: ${reads0} (cumulative, pg_stat_statements)`);

    if (intervalSec === 0) return;

    console.log(`\n=== sampling read + write rate over ${intervalSec}s ===`);
    const t0 = Date.now();
    await sleep(intervalSec * 1000);
    const b = await sampleRow(pool, schema);
    const reads1 = await sampleReadCalls(pool);
    const elapsed = (Date.now() - t0) / 1000;

    const dRev = b.revision - a.revision;
    const writesPerMin = (dRev / elapsed) * 60;
    console.log(`  WRITES: ${a.revision} -> ${b.revision}  (${dRev} in ${elapsed.toFixed(1)}s = ${writesPerMin.toFixed(1)}/min, ~${Math.round(writesPerMin * 60 * 24)}/day)`);

    if (reads0 !== null && reads1 !== null) {
      const dRead = reads1 - reads0;
      const readsPerMin = (dRead / elapsed) * 60;
      const gbPerDay = ((readsPerMin * 60 * 24) * a.bytes) / 1e9;
      console.log(`  READS : ${reads0} -> ${reads1}  (${dRead} in ${elapsed.toFixed(1)}s = ${readsPerMin.toFixed(1)}/min, ~${Math.round(readsPerMin * 60 * 24)}/day)`);
      console.log(`  est. read egress: ~${gbPerDay.toFixed(1)} GB/day  (reads/day × blob size)`);
      // Post-fix the cache misses ~once per TTL (15min => ~0.07 reads/min), so
      // anything above ~1 read/min means the full-blob read path is still live.
      console.log(
        readsPerMin > 1
          ? "  VERDICT: read storm STILL active — each read ships the full blob (deploy the cache)."
          : "  VERDICT: read path quiet — cache is absorbing the reads."
      );
    } else {
      console.log("  READS : pg_stat_statements not reachable over this connection.");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("probe error:", err.message);
  process.exitCode = 1;
});
