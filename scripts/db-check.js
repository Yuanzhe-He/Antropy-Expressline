const { Pool } = require("pg");
const { getDatabaseSchema } = require("../src/lib/db");

function buildPoolConfig() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const url = new URL(process.env.DATABASE_URL);
  if (
    url.searchParams.get("sslmode") &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    url.searchParams.delete("sslmode");
    return {
      connectionString: url.toString(),
      ssl: { rejectUnauthorized: false },
    };
  }

  return { connectionString: process.env.DATABASE_URL };
}

async function main() {
  const pool = new Pool(buildPoolConfig());
  const schema = getDatabaseSchema();

  try {
    const info = await pool.query(`
      select current_database() as database,
             current_user as user,
             version() as version
    `);
    const tables = await pool.query(
      `
        select table_name
        from information_schema.tables
        where table_schema = $1
        order by table_name
      `,
      [schema]
    );
    const appState = await pool.query(
      `
        select key, revision, updated_at
        from ${`"${schema}"`}.app_state
        order by key
      `
    );

    console.log(
      JSON.stringify(
        {
          connected: true,
          schema,
          database: info.rows[0].database,
          user: info.rows[0].user,
          postgresVersion: String(info.rows[0].version).split(" on ")[0],
          tables: tables.rows.map((row) => row.table_name),
          appState: appState.rows,
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
