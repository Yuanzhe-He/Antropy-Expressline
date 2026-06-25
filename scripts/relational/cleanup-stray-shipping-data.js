// STEP 8 / self-correction — remove a STRAY expressline.app_state `shipping-data`
// key that gets re-created if any tool flips STORAGE_MODE=blob and calls
// getShippingData() AFTER the real key was retired: the blob read misses the key,
// falls into the seed branch (store/index.js), and saveAppState() writes the
// BUNDLED SEED back under `shipping-data` (revision=1). That stray seed row is the
// exact "misread trap" Step 8 removes, so we delete it — but ONLY after proving:
//   (1) the real frozen payload is safe under shipping-data-retired-20260625 (rev 215132), and
//   (2) the stray is a fresh seed write (revision=1) whose payload equals the bundled seed.
//
//   node scripts/relational/cleanup-stray-shipping-data.js            # dry-run
//   node scripts/relational/cleanup-stray-shipping-data.js --apply     # delete the stray
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { connectProdAdmin } = require("./prod-env");
const { canonicalJson } = require("../../src/lib/store/relational-repo");
const { normalizeShippingData } = require("../../src/lib/store/normalize-shipping-data");

const STRAY_KEY = "shipping-data";
const RETIRED_KEY = "shipping-data-retired-20260625";
const RETIRED_REV = 215132;
const APPLY = process.argv.includes("--apply");
const seedFile = path.join(__dirname, "../../data/shipping-lines.json");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

(async () => {
  const { pool, ref, schema, role } = connectProdAdmin();
  console.log(`[cleanup-stray] ref=${ref} (PROD) schema=${schema} role=${role} action=${APPLY ? "APPLY delete" : "DRY-RUN"}\n`);
  const client = await pool.connect();
  const fail = async (msg) => {
    console.error(`\n[cleanup-stray] ${msg}`);
    client.release(); await pool.end(); process.exit(2);
  };

  const rows = (await client.query(
    `select key, revision, pg_column_size(payload) as bytes, payload, updated_at
       from ${schema}.app_state where key in ($1,$2) order by key`,
    [STRAY_KEY, RETIRED_KEY]
  )).rows;
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  // GUARD 1 — the real data must be safe under the retired key.
  const retired = byKey[RETIRED_KEY];
  if (!retired || retired.revision !== RETIRED_REV) {
    await fail(`REFUSING: retired anchor ${RETIRED_KEY} missing or wrong revision ` +
      `(have ${retired ? retired.revision : "absent"}, expect ${RETIRED_REV}). Will NOT delete anything.`);
  }
  console.log(`[cleanup-stray] retired anchor OK: ${RETIRED_KEY} revision=${retired.revision} bytes=${retired.bytes} ✅`);

  // GUARD 2 — the stray must exist and be a fresh seed write (revision === 1).
  const stray = byKey[STRAY_KEY];
  if (!stray) {
    console.log(`[cleanup-stray] no stray '${STRAY_KEY}' key present — nothing to do (state already clean).`);
    client.release(); await pool.end(); return;
  }
  if (stray.revision !== 1) {
    await fail(`REFUSING: '${STRAY_KEY}' has revision=${stray.revision} (expected 1 for a fresh seed). ` +
      `This may be real data, NOT a stray seed — aborting.`);
  }

  // GUARD 3 — prove the stray payload equals the bundled seed (defense in depth).
  const seedRaw = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  const seedSha = sha(canonicalJson(normalizeShippingData(seedRaw)));
  const straySha = sha(canonicalJson(normalizeShippingData(stray.payload)));
  const seedMatch = seedSha === straySha;
  console.log(`[cleanup-stray] stray '${STRAY_KEY}' revision=${stray.revision} bytes=${stray.bytes} updated_at=${stray.updated_at?.toISOString?.() || stray.updated_at}`);
  console.log(`[cleanup-stray] stray payload == bundled seed (canonical sha): ${seedMatch ? "YES ✅" : "NO ⚠"}  (seed=${seedSha.slice(0,12)} stray=${straySha.slice(0,12)})`);
  if (!seedMatch) {
    await fail(`REFUSING: stray payload does NOT match the bundled seed — it may contain real edits. Aborting (inspect manually).`);
  }

  if (!APPLY) {
    console.log(`\n[cleanup-stray] DRY-RUN — would DELETE key='${STRAY_KEY}' WHERE revision=1. Re-run with --apply.`);
    client.release(); await pool.end(); return;
  }

  await client.query("begin");
  const del = await client.query(`delete from ${schema}.app_state where key=$1 and revision=1`, [STRAY_KEY]);
  if (del.rowCount !== 1) {
    await client.query("rollback");
    await fail(`REFUSING: DELETE affected ${del.rowCount} rows (expected 1) — rolled back.`);
  }
  const remaining = (await client.query(`select key, revision from ${schema}.app_state order by key`)).rows;
  await client.query("commit");
  console.log(`\n[cleanup-stray] deleted stray '${STRAY_KEY}' (rowCount=1). Remaining keys:`);
  for (const r of remaining) console.log(`   ${r.key.padEnd(30)} revision=${r.revision}`);
  client.release(); await pool.end();
})().catch((e) => { console.error("[cleanup-stray] ERROR:", e.message); process.exit(1); });
