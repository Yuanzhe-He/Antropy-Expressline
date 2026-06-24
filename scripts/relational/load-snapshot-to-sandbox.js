// Load the prod blob snapshot into the SANDBOX app_state (overwriting the seed),
// as the dry-run input. Sandbox-guarded; writes only to the sandbox project.
const fs = require("node:fs");
const path = require("node:path");
const { connectSandbox } = require("./sandbox-env");
const repo = require("./repo");

const SNAP = path.join(__dirname, "../../.prod-blob-snapshot.json");

(async () => {
  if (!fs.existsSync(SNAP)) {
    throw new Error("[load-snapshot] .prod-blob-snapshot.json not found — run read-prod-blob first");
  }
  const blob = JSON.parse(fs.readFileSync(SNAP, "utf8"));
  const { pool, ref, schema } = connectSandbox(); // hard-asserts ref == sandbox

  const client = await pool.connect();
  try {
    await repo.ensureBaseTables(client, schema);
  } finally {
    client.release();
  }
  await repo.writeBlob(pool, schema, blob);

  const back = await repo.readBlob(pool, schema);
  console.log(
    `[load-snapshot] ref=${ref} schema=${schema} — prod blob loaded into sandbox app_state` +
      ` (carriers=${back.modules?.handover?.shippingLines?.length},` +
      ` yards=${back.modules?.customs?.yards?.length},` +
      ` dests=${back.modules?.inland?.destinations?.length})`
  );
  await pool.end();
})().catch((e) => {
  console.error("[load-snapshot]", e.message);
  process.exit(1);
});
