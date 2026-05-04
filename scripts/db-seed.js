const fs = require("node:fs/promises");
const path = require("node:path");
const {
  closeDatabase,
  getDatabaseSchema,
  saveAppState,
} = require("../src/lib/db");
const { normalizeShippingData } = require("../src/lib/store");

async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const dataDir = path.join(__dirname, "../data");
  const shippingData = normalizeShippingData(
    await readJson(path.join(dataDir, "shipping-lines.json"), { modules: {} })
  );
  const usersData = await readJson(path.join(dataDir, "users.json"), {
    users: [],
  });

  await saveAppState("shipping-data", shippingData);
  await saveAppState("users", usersData);

  console.log(
    `db-seed-ok schema=${getDatabaseSchema()} modules=${Object.keys(
      shippingData.modules
    ).length} users=${usersData.users?.length || 0}`
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
