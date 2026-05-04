process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER || "json";

const { getShippingData, saveShippingData } = require("../src/lib/store");

async function main() {
  const data = await getShippingData();
  await saveShippingData(data);

  const modules = data.modules || {};
  const summary = Object.entries(modules)
    .map(([key, moduleData]) => {
      const shippingLines = moduleData.shippingLines?.length || 0;
      const ports = moduleData.ports?.length || 0;
      const yards = moduleData.yards?.length || 0;
      return `${key}: ${shippingLines} shipping lines, ${ports} ports, ${yards} yards`;
    })
    .join("; ");

  console.log(`data-normalized${summary ? ` (${summary})` : ""}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
