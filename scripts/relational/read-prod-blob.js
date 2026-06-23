// ONE read-only read of PRODUCTION expressline.app_state[shipping-data] for the
// pre-cutover dry-run. The ONLY action this whole task takes against production.
//
// Safety, three layers:
//   (1) ref assertion — DATABASE_URL must point at the prod project, else abort.
//   (2) read-only transaction — `set transaction read only` makes any write impossible.
//   (3) the ONLY SQL is `select payload from expressline.app_state where key=...`.
//       Never public.joyas_* / public.punas_* / any other schema. No DDL. No write.
//
// Saves the blob to the gitignored .prod-blob-snapshot.json (+ size + sha256).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { loadLocalEnv } = require("../../src/lib/env");
const { extractProjectRef } = require("../sandbox-guard");

const PROD_REF = "polxyashvxbzdkkmxuox"; // expressline + joyas + punas live here
const OUT = path.join(__dirname, "../../.prod-blob-snapshot.json");

loadLocalEnv(); // loads the prod .env → DATABASE_URL

(async () => {
  const ref = extractProjectRef(process.env.DATABASE_URL);
  if (ref !== PROD_REF) {
    throw new Error(`[read-prod] REFUSING: DATABASE_URL ref ${ref} != prod ${PROD_REF}`);
  }

  const url = new URL(process.env.DATABASE_URL);
  let cfg;
  if (url.searchParams.get("sslmode") && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.delete("sslmode");
    cfg = { connectionString: url.toString(), ssl: { rejectUnauthorized: false }, max: 1 };
  } else {
    cfg = { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 };
  }

  const pool = new Pool(cfg);
  const client = await pool.connect();
  let payload = null;
  try {
    await client.query("begin");
    await client.query("set transaction read only"); // HARD read-only: no write can succeed
    const r = await client.query(
      "select payload from expressline.app_state where key = $1",
      ["shipping-data"]
    );
    await client.query("commit");
    payload = r.rows[0]?.payload || null;
  } finally {
    client.release();
    await pool.end();
  }

  if (!payload) {
    throw new Error("[read-prod] no expressline.app_state[shipping-data] blob found in prod");
  }
  const json = JSON.stringify(payload);
  fs.writeFileSync(OUT, json);
  const sha = crypto.createHash("sha256").update(json).digest("hex");
  console.log(`[read-prod] ref=${ref} (PROD) — read expressline.app_state[shipping-data] ONLY, read-only txn`);
  console.log(`[read-prod] carriers=${payload.modules?.handover?.shippingLines?.length} yards=${payload.modules?.customs?.yards?.length} dests=${payload.modules?.inland?.destinations?.length}`);
  console.log(`[read-prod] saved ${path.basename(OUT)} (gitignored) | bytes=${json.length} (${(json.length / 1048576).toFixed(2)} MB) | sha256=${sha}`);
})().catch((e) => {
  console.error("[read-prod]", e.message);
  process.exit(1);
});
