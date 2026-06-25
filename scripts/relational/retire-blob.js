// STEP 8 / PART D — REVERSIBLE retirement of the frozen expressline.app_state
// shipping-data blob via a KEY RENAME (NOT a delete). The payload is preserved
// in full under a retired key; a one-flag --revert restores the original name.
// Hard delete (DROP of the retired row) is intentionally NOT implemented here —
// it is the only irreversible action and is deferred to a later safety window.
//
//   node scripts/relational/retire-blob.js            # dry-run (default): print plan, no write
//   node scripts/relational/retire-blob.js --apply     # rename shipping-data -> shipping-data-retired-20260625
//   node scripts/relational/retire-blob.js --revert     # rename retired key back to shipping-data
//
// SAFETY:
//   * admin creds (postgres) — the only role that can write app_state; migrator is SELECT-only.
//   * assertProd (ref == polxyashvxbzdkkmxuox) via connectProdAdmin — fail-closed.
//   * expressline.app_state ONLY. The WHERE clause targets a single key; rowCount must be
//     exactly 1, and the total key count must be unchanged (proves `users` is never touched).
//   * single transaction; refuses to clobber an existing target key; refuses --apply unless the
//     PART B archive (backups/app_state-shipping-data-retired-20260625.json) exists on disk.
const fs = require("node:fs");
const path = require("node:path");
const { connectProdAdmin } = require("./prod-env");

const LIVE_KEY = "shipping-data";
const RETIRED_KEY = "shipping-data-retired-20260625";
const ARCHIVE = path.join(__dirname, "../../backups/app_state-shipping-data-retired-20260625.json");

const APPLY = process.argv.includes("--apply");
const REVERT = process.argv.includes("--revert");
if (APPLY && REVERT) {
  console.error("[retire-blob] choose ONE of --apply / --revert, not both.");
  process.exit(1);
}

async function snapshot(client, schema) {
  const r = await client.query(
    `select key, revision, pg_column_size(payload) as bytes, updated_at
       from ${schema}.app_state where key in ($1, $2) order by key`,
    [LIVE_KEY, RETIRED_KEY]
  );
  const total = (await client.query(`select count(*)::int n from ${schema}.app_state`)).rows[0].n;
  return { byKey: Object.fromEntries(r.rows.map((x) => [x.key, x])), total };
}

function describe(label, snap) {
  console.log(`[retire-blob] ${label}: total app_state keys=${snap.total}`);
  for (const k of [LIVE_KEY, RETIRED_KEY]) {
    const row = snap.byKey[k];
    console.log(`   ${k.padEnd(30)} ${row ? `present (revision=${row.revision}, bytes=${row.bytes})` : "absent"}`);
  }
}

(async () => {
  const { pool, ref, schema, role } = connectProdAdmin();
  const action = APPLY ? "APPLY rename" : REVERT ? "REVERT rename" : "DRY-RUN";
  const from = REVERT ? RETIRED_KEY : LIVE_KEY;
  const to = REVERT ? LIVE_KEY : RETIRED_KEY;
  console.log(`[retire-blob] ref=${ref} (PROD) schema=${schema} role=${role} action=${action} (${from} -> ${to})\n`);

  const client = await pool.connect();
  let inTxn = false;
  const fail = async (msg, code = 2) => {
    console.error(`\n[retire-blob] ${msg}`);
    if (inTxn) { try { await client.query("rollback"); } catch (_) {} }
    client.release();
    await pool.end();
    process.exit(code);
  };

  const before = await snapshot(client, schema);
  describe("BEFORE", before);

  // ---- preflight (same for dry-run and write) ----
  if (!before.byKey[from]) {
    await fail(`REFUSING: source key '${from}' is absent — nothing to rename` +
      `${from === LIVE_KEY ? " (already retired? run with --revert to restore)" : " (already restored?)"}.`);
  }
  if (before.byKey[to]) {
    await fail(`REFUSING: target key '${to}' already exists — will not clobber it.`);
  }
  if (APPLY && !fs.existsSync(ARCHIVE)) {
    await fail(`REFUSING --apply: PART B archive missing at ${ARCHIVE}. ` +
      `Run: node scripts/relational/export-app-state-row.js`);
  }
  if (APPLY) {
    const sz = fs.statSync(ARCHIVE).size;
    if (sz < 1_000_000) await fail(`REFUSING --apply: archive ${ARCHIVE} is suspiciously small (${sz} bytes).`);
    console.log(`\n[retire-blob] PART B archive present (${sz} bytes) ✅`);
  }

  if (!APPLY && !REVERT) {
    console.log(`\n[retire-blob] DRY-RUN — would rename key '${from}' -> '${to}' in a single transaction.`);
    console.log(`[retire-blob] No write performed. Re-run with --apply (or --revert) to execute.`);
    client.release();
    await pool.end();
    return;
  }

  // ---- the write: single transaction, exactly one row, total count unchanged ----
  await client.query("begin");
  inTxn = true;
  const upd = await client.query(`update ${schema}.app_state set key = $2 where key = $1`, [from, to]);
  if (upd.rowCount !== 1) {
    await fail(`REFUSING: UPDATE affected ${upd.rowCount} rows (expected exactly 1) — rolled back.`);
  }
  const after = await snapshot(client, schema);
  if (after.total !== before.total) {
    await fail(`REFUSING: total key count changed ${before.total} -> ${after.total} — rolled back.`);
  }
  if (after.byKey[from] || !after.byKey[to]) {
    await fail(`REFUSING: post-rename state inconsistent (from still present or to absent) — rolled back.`);
  }
  const sameRev = after.byKey[to].revision === before.byKey[from].revision;
  const sameBytes = after.byKey[to].bytes === before.byKey[from].bytes;
  await client.query("commit");
  inTxn = false;

  describe("AFTER", after);
  console.log(`\n[retire-blob] rename committed: '${from}' -> '${to}'  (rowCount=1, total keys ${after.total} unchanged)`);
  console.log(`[retire-blob] payload preserved: revision ${sameRev ? "same ✅" : "CHANGED ❌"}, bytes ${sameBytes ? "same ✅" : "CHANGED ❌"}`);
  console.log(`[retire-blob] revert with: node scripts/relational/retire-blob.js --revert`);

  client.release();
  await pool.end();
})().catch((e) => {
  console.error("[retire-blob] ERROR:", e.message);
  process.exit(1);
});
