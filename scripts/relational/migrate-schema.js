// Apply the relational target schema (subphase 2a) to the SANDBOX, idempotently.
// connectSandbox() hard-asserts the project ref before any DDL runs. Re-runnable.
const { connectSandbox } = require("./sandbox-env");
const { buildSchemaDDL, buildDropDDL, RELATIONAL_TABLES } = require("./schema");

(async () => {
  const reset = process.argv.includes("--reset");
  const { pool, ref, schema } = connectSandbox();
  console.log(`[migrate-schema] sandbox ref=${ref} schema=${schema}${reset ? " (--reset)" : ""}`);
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (reset) {
      for (const stmt of buildDropDDL(schema)) {
        await client.query(stmt);
      }
    }
    for (const stmt of buildSchemaDDL(schema)) {
      await client.query(stmt);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(
    `select table_name from information_schema.tables
       where table_schema = $1 and table_type = 'BASE TABLE'
       order by table_name`,
    [schema]
  );
  const present = new Set(rows.map((r) => r.table_name));
  const missing = RELATIONAL_TABLES.filter((t) => !present.has(t));
  console.log(
    `[migrate-schema] ${schema} now has ${rows.length} tables: ${rows
      .map((r) => r.table_name)
      .join(", ")}`
  );
  if (missing.length) {
    console.error(`[migrate-schema] MISSING relational tables: ${missing.join(", ")}`);
    await pool.end();
    process.exit(1);
  }
  console.log(`[migrate-schema] OK — all ${RELATIONAL_TABLES.length} relational tables present`);
  await pool.end();
})().catch((error) => {
  console.error("[migrate-schema] FAILED:", error.message);
  process.exit(1);
});
