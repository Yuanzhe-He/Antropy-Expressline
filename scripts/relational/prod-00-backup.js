// PHASE 0 — Backup (expressline only). Exports prod expressline.app_state (+ audit_logs,
// quote_snapshots) to gitignored local files with row counts + sha256. HARD read-only
// transaction; touches NO joyas_*/punas_* data. This is the rollback anchor for the cutover.
//
// HARD GATE: each backup file exists, is readable, its row count == the live DB count, and
// its sha256 is recorded. (app_state must have >0 rows; audit_logs may legitimately be 0.)
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { connectProdAdmin } = require("./prod-env");

const TABLES = ["app_state", "audit_logs", "quote_snapshots"];

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(__dirname, "../../backups", `prod-cutover-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const { pool, ref, schema, role } = connectProdAdmin();
  console.log(`[phase0-backup] ref=${ref} (PROD) schema=${schema} role=${role}`);
  console.log(`[phase0-backup] outDir=${path.relative(path.join(__dirname, "../.."), outDir)} (gitignored)`);

  const manifest = { ref, schema, takenAt: new Date().toISOString(), role, tables: {} };
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set transaction read only"); // HARD read-only — no write can succeed

    for (const table of TABLES) {
      // existence + live count
      const exists = await client.query(
        `select 1 from information_schema.tables where table_schema=$1 and table_name=$2`,
        [schema, table]
      );
      if (!exists.rows.length) {
        console.log(`   ${table}: ABSENT in prod — skipping (noted)`);
        manifest.tables[table] = { present: false };
        continue;
      }
      const liveCount = (await client.query(`select count(*)::int n from ${schema}."${table}"`)).rows[0].n;
      const rows = (await client.query(`select * from ${schema}."${table}"`)).rows;
      const json = JSON.stringify(rows, null, 0);
      const sha = crypto.createHash("sha256").update(json).digest("hex");
      const file = path.join(outDir, `${table}.json`);
      fs.writeFileSync(file, json);

      // verify file readable + parses + count matches
      const readBack = JSON.parse(fs.readFileSync(file, "utf8"));
      const ok = Array.isArray(readBack) && readBack.length === liveCount && rows.length === liveCount;
      manifest.tables[table] = { present: true, rows: liveCount, bytes: json.length, sha256: sha, file: `${table}.json`, verified: ok };
      console.log(`   ${table.padEnd(16)} rows=${String(liveCount).padEnd(4)} bytes=${String(json.length).padEnd(9)} sha256=${sha.slice(0, 16)}… verified=${ok}`);
      if (!ok) throw new Error(`[phase0-backup] verify FAILED for ${table} (file count != live count)`);
    }

    await client.query("commit");
  } finally {
    client.release();
    await pool.end();
  }

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // HARD GATE evaluation
  const appState = manifest.tables.app_state;
  const gatePass =
    appState && appState.present && appState.rows > 0 && appState.verified &&
    Object.values(manifest.tables).every((t) => !t.present || t.verified);
  console.log(`\n[phase0-backup] manifest: backups/prod-cutover-${stamp}/manifest.json`);
  console.log(`[phase0-backup] HARD GATE — backup exists+readable+counts match+app_state>0+sha recorded: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);
  if (!gatePass) process.exit(2);
})().catch((e) => {
  console.error("[phase0-backup] ERROR:", e.message);
  process.exit(1);
});
