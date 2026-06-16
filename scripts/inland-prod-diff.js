// Pre-seed safety gate for the burreo enrichment (Step 4).
// 1. Reads prod inland (read-only) and backs up modules.inland to a local file.
// 2. Diffs prod rateEntries vs a fresh CSV re-parse, IGNORING the new burreo
//    field, to detect any manual prod edits (disabled rows, notes, price edits,
//    extra/missing rows) that a wholesale --replace would clobber.
// Prints a verdict: CLEAN (only burreo would be added -> --replace safe) or
// ANOMALY (-> do NOT --replace; use a burreo-only merge instead). No prod write.

const fs = require("node:fs");
const path = require("node:path");
const { getShippingData } = require("../src/lib/store");
const { cleanInlandCsv, decodeCsvBuffer } = require("../src/lib/inland-csv");

(async () => {
  const data = await getShippingData();
  const inland = data.modules.inland || {};
  const prod = inland.rateEntries || [];

  const backupPath = path.join(
    __dirname,
    "../docs/specs/20260614_prod_inland_backup_pre_burreo.json"
  );
  fs.writeFileSync(backupPath, JSON.stringify(inland, null, 2));
  console.log(
    `Backup written: docs/specs/20260614_prod_inland_backup_pre_burreo.json\n` +
      `  rateEntries=${prod.length} destinations=${(inland.destinations || []).length} ` +
      `routeCache=${(inland.routeCache || []).length}`
  );

  const csv = cleanInlandCsv(
    decodeCsvBuffer(fs.readFileSync(path.join(__dirname, "../data/source-tarifario-2026.csv")))
  );
  const csvEntries = csv.rateEntries;

  const prodById = new Map(prod.map((e) => [e.id, e]));
  const csvById = new Map(csvEntries.map((e) => [e.id, e]));

  const compareFields = [
    "originId",
    "destinationId",
    "proveedor",
    "sencillo",
    "full",
    "cliente",
    "codigoCw",
    "commodity",
    "enabled",
  ];
  const fieldDiffs = [];
  const prodOnly = [];
  const csvOnly = [];
  const burreoChanges = [];
  const prodEdits = [];

  for (const [id, p] of prodById) {
    const c = csvById.get(id);
    if (!c) {
      prodOnly.push(p);
      continue;
    }
    for (const f of compareFields) {
      if (String(p[f] ?? "") !== String(c[f] ?? "")) {
        fieldDiffs.push({ id, field: f, prod: p[f], csv: c[f], dest: p.destinationId, prov: p.proveedor });
      }
    }
    if (p.enabled === false) {
      prodEdits.push({ id, reason: "disabled", dest: p.destinationId, prov: p.proveedor });
    }
    if (p.note && String(p.note).trim()) {
      prodEdits.push({ id, reason: "note", note: p.note, dest: p.destinationId, prov: p.proveedor });
    }
    const pB = p.burreo ? JSON.stringify(p.burreo) : null;
    const cB = c.burreo ? JSON.stringify(c.burreo) : null;
    if (pB !== cB) {
      burreoChanges.push({ id, dest: p.destinationId, prov: p.proveedor, from: pB, to: cB });
    }
  }
  for (const [id, c] of csvById) {
    if (!prodById.has(id)) {
      csvOnly.push(c);
    }
  }

  const show = (label, arr, n = 8) => {
    console.log(`\n${label}: ${arr.length}`);
    arr.slice(0, n).forEach((x) => console.log("   " + JSON.stringify(x)));
    if (arr.length > n) console.log(`   … +${arr.length - n} more`);
  };

  console.log("\n=== DIFF SUMMARY (prod rateEntries vs CSV re-parse) ===");
  console.log(`prod entries=${prod.length} · csv entries=${csvEntries.length}`);
  console.log(`burreo changes (EXPECTED): ${burreoChanges.length}`);
  if (fieldDiffs.length) show("NON-burreo field diffs (ANOMALY)", fieldDiffs);
  else console.log("NON-burreo field diffs (ANOMALY if >0): 0");
  if (prodOnly.length) show("prod-only entries (ANOMALY)", prodOnly.map((e) => ({ id: e.id, dest: e.destinationId, prov: e.proveedor })));
  else console.log("prod-only entries (ANOMALY if >0): 0");
  if (csvOnly.length) show("csv-only entries (ANOMALY)", csvOnly.map((e) => ({ id: e.id, dest: e.destinationId, prov: e.proveedor })));
  else console.log("csv-only entries (ANOMALY if >0): 0");
  if (prodEdits.length) show("prod manual edits — disabled/notes (ANOMALY)", prodEdits);
  else console.log("prod manual edits — disabled/notes (ANOMALY if >0): 0");

  const clean =
    fieldDiffs.length === 0 &&
    prodOnly.length === 0 &&
    csvOnly.length === 0 &&
    prodEdits.length === 0;
  console.log(
    `\nVERDICT: ${
      clean
        ? "CLEAN — only burreo would be added; --replace is safe per authorization."
        : "ANOMALY — prod has edits/extra/missing rows; DO NOT --replace. Use burreo-only merge."
    }`
  );
  process.exit(0);
})().catch((error) => {
  console.error(String(error.message).split("\n")[0]);
  process.exit(1);
});
