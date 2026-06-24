// CI guard that LOCKS IN the code-level multi-tenant isolation. Express Line shares ONE
// Supabase project with two sibling businesses (public.joyas_*, public.punas_*), and the
// app role (postgres) CAN reach their tables at the DB level — so the ONLY thing keeping
// Express Line from ever touching them is that the code never references them. This test
// FAILS if any joyas_/punas_ reference appears under src/, so a stray cross-tenant query
// is caught in CI instead of in production.
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "../src");
const PATTERN = /\b(joyas_|punas_)/i; // the sibling-business table prefixes
const offenders = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(js|ejs)$/.test(entry.name)) {
      continue;
    }
    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (PATTERN.test(line)) {
        offenders.push(`${path.relative(SRC, full)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
}

walk(SRC);

if (offenders.length) {
  console.error("[audit-cross-tenant-isolation] FAIL — cross-tenant references found under src/:");
  offenders.forEach((o) => console.error("   " + o));
  console.error(
    "  Express Line MUST NEVER query public.joyas_*/punas_* (shared Supabase project; isolation is code-level)."
  );
  process.exit(1);
}

console.log("  PASS  src/ has ZERO joyas_/punas_ references (code-level tenant isolation intact)");
console.log("\n[audit-cross-tenant-isolation] 1 assertion PASS ✅");
