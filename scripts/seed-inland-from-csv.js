// Seed inland rate entries from the TARIFARIO terrestres CSV.
//
// Usage:
//   node scripts/seed-inland-from-csv.js <path-to-csv>            # local JSON only
//   node scripts/seed-inland-from-csv.js <csv> --target=production --confirm-production
//
// CSV is decoded from Latin-1. The cleaning/split logic lives in
// src/lib/inland-csv.js (unit-tested). Merge is idempotent by
// (destinationId, proveedor, cliente, commodity). Excel/CSV is never a runtime
// data source — this writes through the store layer (JSON or Postgres).

const fs = require("node:fs");
const path = require("node:path");
const { cleanInlandCsv, mergeRateEntries, decodeCsvBuffer } = require("../src/lib/inland-csv");
const { INLAND_DESTINATION_CATALOG } = require("../src/lib/inland-catalog");

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      flags[key] = value === undefined ? true : value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function buildReportMarkdown(report, merge, csvPath) {
  const needsReview = INLAND_DESTINATION_CATALOG.filter(
    (dest) => dest.needsReview && report.touchedDestinations.includes(dest.id)
  ).map((dest) => `${dest.id} (${dest.name})`);
  const lines = [
    "# Inland CSV seed report",
    "",
    `Source: ${csvPath}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    `- Rows read: ${report.totalRows}`,
    `- Rate entries produced: ${report.totalEntries}`,
    `- Destinations touched: ${report.touchedDestinations.length}`,
    `- Split rows: ${report.splitRows.length}`,
    `- Entries with null FULL: ${report.nullFullRows}`,
    `- Merge: ${merge.added} added, ${merge.updated} updated`,
    "",
    "## Split rows",
    ...(report.splitRows.length
      ? report.splitRows.map((row) => `- ${row.destino} -> ${row.ids.join(", ")}`)
      : ["- (none)"]),
    "",
    "## Unmapped DESTINO values (skipped — add to inland-catalog.js)",
    ...(report.unmappedDestinos.length
      ? report.unmappedDestinos.map((value) => `- ${value}`)
      : ["- (none)"]),
    "",
    "## Duplicate-key groups (same base key, multiple price tiers kept)",
    ...(report.duplicateKeyGroups && report.duplicateKeyGroups.length
      ? report.duplicateKeyGroups.map(
          (g) =>
            `- ${g.destinationId} · ${g.proveedor || "(no supplier)"}${g.cliente ? ` · ${g.cliente}` : ""}: ${g.count} tiers — ` +
            g.tiers
              .map((t) => `S ${t.sencillo == null ? "—" : t.sencillo} / F ${t.full == null ? "—" : t.full}`)
              .join(" | ")
        )
      : ["- (none)"]),
    "",
    "## needsReview destinations touched",
    ...(needsReview.length ? needsReview.map((value) => `- ${value}`) : ["- (none)"]),
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const csvPath = positional[0];
  if (!csvPath) {
    console.error("Usage: node scripts/seed-inland-from-csv.js <csv> [--target=production --confirm-production]");
    process.exit(1);
  }

  const resolvedCsv = path.resolve(csvPath);
  if (!fs.existsSync(resolvedCsv)) {
    console.error(`CSV not found: ${resolvedCsv}`);
    process.exit(1);
  }

  const text = decodeCsvBuffer(fs.readFileSync(resolvedCsv));
  const { rateEntries, report } = cleanInlandCsv(text);

  const target = flags.target === "production" ? "production" : "local";
  if (target === "production") {
    if (!flags["confirm-production"]) {
      console.error(
        "Refusing to write to production without --confirm-production. " +
          "Re-run with --target=production --confirm-production after reviewing the diff."
      );
      process.exit(1);
    }
  } else {
    // Default: write to the local JSON store, never the database.
    process.env.STORAGE_DRIVER = "json";
  }

  // Required after STORAGE_DRIVER is set so the store picks the right driver.
  const { getShippingData, saveShippingData } = require("../src/lib/store");
  const data = await getShippingData();
  data.modules = data.modules || {};
  data.modules.inland = data.modules.inland || {};
  const existing = data.modules.inland.rateEntries || [];
  const merge = mergeRateEntries(existing, rateEntries);
  data.modules.inland.rateEntries = merge.entries;

  const reportMd = buildReportMarkdown(report, merge, resolvedCsv);
  const reportPath = path.join(
    __dirname,
    "..",
    "docs",
    "specs",
    "20260610_inland_seed_report.md"
  );
  fs.writeFileSync(reportPath, reportMd, "utf8");

  console.log(reportMd);
  console.log(`\nWriting to ${target} store: ${merge.added} added, ${merge.updated} updated.`);
  if (report.unmappedDestinos.length) {
    console.log(
      `WARNING: ${report.unmappedDestinos.length} unmapped DESTINO value(s) skipped — see report.`
    );
  }

  await saveShippingData(data);
  console.log("inland-seed-ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
