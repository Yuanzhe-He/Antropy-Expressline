const {
  closeDatabase,
  getDatabaseSchema,
  migrateDatabase,
} = require("../src/lib/db");

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  await migrateDatabase();
  console.log(`db-migrate-ok schema=${getDatabaseSchema()}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
