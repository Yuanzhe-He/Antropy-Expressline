// PART D (read-only) — who reads app_state? The role discriminator.
// Supabase API request logs (IP / user-agent / timing) live in the Dashboard
// (browser-auth, user-only), but pg_stat_statements attributes each call to the
// executing DB ROLE — and role is the key signal: service_role/authenticator =
// Dashboard or admin (harmless); anon = an external anon integration reading the
// frozen blob (needs repointing/retirement).
//
// HARD read-only. Touches only pg_stat_statements / pg_roles. No write.
//   node scripts/relational/probe-app-state-readers.js

const { connectProdAdmin } = require("./prod-env");

async function main() {
  const { pool, ref, schema, role } = connectProdAdmin();
  console.log(`ref=${ref} (PROD) schema=${schema} role=${role} mode=READ-ONLY\n`);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set transaction read only");

    const stats = await c.query(
      `select r.rolname as role, s.calls, s.rows, s.query
         from pg_stat_statements s
         join pg_roles r on r.oid = s.userid
        where s.query ilike '%app_state%'
        order by s.calls desc
        limit 30`
    );
    console.log("app_state query stats by executing DB role:");
    if (!stats.rows.length) {
      console.log("  (no app_state rows in pg_stat_statements — stats may have been reset)");
    }
    for (const row of stats.rows) {
      const q = String(row.query).replace(/\s+/g, " ").slice(0, 110);
      const isSelectStar = /select\s+\*\s+from\s+["a-z._]*app_state/i.test(q) || /app_state/i.test(q);
      console.log(
        `  role=${String(row.role).padEnd(16)} calls=${String(row.calls).padStart(7)} rows=${String(row.rows).padStart(9)} | ${q}`
      );
    }

    // Roles that exist (so we can interpret who 'anon'/'authenticator'/'service_role' are).
    const roles = await c.query(
      `select rolname from pg_roles where rolname in
       ('anon','authenticated','authenticator','service_role','postgres','supabase_admin','dashboard_user')
       order by rolname`
    );
    console.log(`\nrelevant roles present: ${roles.rows.map((r) => r.rolname).join(", ")}`);

    await c.query("commit");
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[probe-app-state-readers] ERROR:", e.message);
  process.exit(1);
});
