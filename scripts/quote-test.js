// Quote-section integration tests against REAL seed data (data/shipping-lines.json).
// Runs in an isolated temp DATA_DIR so the tracked JSON is never mutated.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Force JSON storage + isolated data dir BEFORE requiring store/db.
process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER === "postgres" ? "postgres" : "json";
process.env.SKIP_FX_REFRESH = "1";
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quote-test-"));
if (process.env.STORAGE_DRIVER === "json") {
  // Seed the isolated dir from the real bundled data so we exercise real
  // shipping lines / ports / destinations without touching the tracked file.
  fs.copyFileSync(
    path.join(__dirname, "../data/shipping-lines.json"),
    path.join(tmpDataDir, "shipping-lines.json")
  );
  process.env.DATA_DIR = tmpDataDir;
}

const { getShippingData, saveShippingData } = require("../src/lib/store");
const {
  pullCalculatorValues,
  computeQuoteTotals,
  groupRowsForRender,
  generateQuoteNumber,
  loadFeeCodes,
  buildInitialLineItems,
} = require("../src/lib/quote");
const {
  computeCalculator,
  computeCustomsCalculator,
  computeInlandCalculator,
} = require("../src/lib/calculate");
const { renderQuotePdf, closeQuoteBrowser } = require("../src/lib/quote-pdf");
const { buildTranslator } = require("../src/lib/i18n");
const { shouldUseDatabase, insertQuoteSnapshot, listQuoteSnapshots } = require("../src/lib/db");

const t = buildTranslator("zh");
const results = [];
function record(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push([true, name]);
      console.log(`  PASS  ${name}`);
    })
    .catch((error) => {
      results.push([false, name]);
      console.log(`  FAIL  ${name}\n        ${error.message}`);
    });
}

function approx(a, b, tol = 0.02) {
  return Math.abs(Number(a) - Number(b)) <= tol;
}
function findRow(rows, module, field) {
  return rows.find((r) => r.calcRef && r.calcRef.module === module && r.calcRef.field === field);
}

async function main() {
  const data = await getShippingData();
  const handover = data.modules.handover;
  const customs = data.modules.customs;
  const inland = data.modules.inland;
  const calculators = {
    computeHandoverCalculator: computeCalculator,
    computeCustomsCalculator,
    computeInlandCalculator,
  };

  // Choose a container key + handover line that actually yield positive charges.
  const containerKey = handover.containerTypes[0].key;
  const port = customs.ports[0];
  const terminal = port.terminals[0];
  const destinationId = "apodaca";

  const pickLineWithDemurrage = () => {
    for (const line of handover.shippingLines) {
      const r = computeCalculator(
        line,
        {
          shippingLineId: line.id,
          blCount: 1,
          demurrageDays: 15,
          priceMode: "pretax",
          quoteCurrency: "USD",
          businessNature: "handover_only",
          taxOverrides: {},
          containerRows: [{ containerGroupKey: containerKey, quantity: 2 }],
        },
        { exchangeRates: data.exchangeRates, settings: handover.settings, containerTypes: handover.containerTypes },
        { t }
      );
      if (Number(r?.demurrage?.pretaxTotal) > 0) return { line, expected: r.demurrage.pretaxTotal, currency: r.quoteCurrency };
    }
    return { line: handover.shippingLines[0], expected: 0 };
  };
  const dem = pickLineWithDemurrage();

  const customsExpected = computeCustomsCalculator(
    customs,
    {
      shippingLineId: customs.shippingLines?.[0]?.id || dem.line.id,
      portId: port.id,
      terminalId: terminal.id,
      yardId: "",
      storageDays: 15,
      priceMode: "pretax",
      quoteCurrency: "MXN",
      businessNature: "customs_only",
      taxOverrides: {},
      containerRows: [{ containerGroupKey: containerKey, quantity: 2 }],
    },
    { exchangeRates: data.exchangeRates },
    { t }
  );

  const inlandSencillo = computeInlandCalculator(
    inland,
    { destinationId, serviceType: "sencillo", quantity: 2, priceMode: "pretax", taxRateOverride: "default", precisePointId: "" },
    { t }
  );
  const inlandFull = computeInlandCalculator(
    inland,
    { destinationId, serviceType: "full", quantity: 2, priceMode: "pretax", taxRateOverride: "default", precisePointId: "" },
    { t }
  );

  // ---- B1: pull path fills calc rows from real data ----
  await record("B1 pull fills calc rows (real data, matches direct calculators)", () => {
    const pulled = pullCalculatorValues({
      shippingData: data,
      inputs: {
        shippingLineId: dem.line.id,
        portId: port.id,
        terminalId: terminal.id,
        destinationId,
        containerTypeKey: containerKey,
        quantity: 2,
        demurrageDays: 15,
        storageDays: 15,
      },
      lineItems: buildInitialLineItems(),
      calculators,
      t,
    });
    // happy paths that the seed guarantees:
    const sencillo = findRow(pulled, "inland", "sencillo");
    const full = findRow(pulled, "inland", "full");
    assert.ok(inlandSencillo.maxRate > 0 && !inlandSencillo.noRate, "seed apodaca has sencillo rate");
    assert.ok(inlandFull.maxRate > 0 && !inlandFull.noRate, "seed apodaca has full rate");
    assert.equal(sencillo.source, "calc", "sencillo source=calc");
    assert.ok(approx(sencillo.unitPrice, inlandSencillo.maxRate), "sencillo unitPrice = inland maxRate");
    assert.equal(sencillo.currency, "MXN", "sencillo currency MXN");
    assert.equal(sencillo.unit, 2, "sencillo unit=quantity");
    assert.ok(approx(full.unitPrice, inlandFull.maxRate), "full unitPrice = inland maxRate");
    // demurrage (USD) when the line has a positive charge:
    const detention = findRow(pulled, "handover", "demurrage");
    if (dem.expected > 0) {
      assert.equal(detention.source, "calc", "detention source=calc");
      assert.ok(approx(detention.unitPrice, dem.expected), "detention unitPrice = handover demurrage");
      assert.equal(detention.currency, dem.currency || "USD", "detention currency from handover result");
    }
    // customs terminalFixed / terminalStorage when positive:
    const portFee = findRow(pulled, "customs", "terminalFixed");
    const storage = findRow(pulled, "customs", "terminalStorage");
    if (customsExpected.terminalFixed.pretaxTotal > 0) {
      assert.equal(portFee.source, "calc", "terminalFixed source=calc");
      assert.ok(approx(portFee.unitPrice, customsExpected.terminalFixed.pretaxTotal), "terminalFixed value");
      assert.equal(portFee.currency, "MXN", "terminalFixed MXN");
    }
    if (customsExpected.terminalStorage.pretaxTotal > 0) {
      assert.ok(approx(storage.unitPrice, customsExpected.terminalStorage.pretaxTotal), "terminalStorage value");
    }
    // prove at least one of detention/fixed/storage actually computed > 0 with real data
    assert.ok(
      dem.expected > 0 || customsExpected.terminalFixed.pretaxTotal > 0 || customsExpected.terminalStorage.pretaxTotal > 0,
      "at least one handover/customs calc produced a positive charge from seed data"
    );
  });

  // ---- B2: zero-value guard keeps AT COST (verifies A2) ----
  await record("B2 zero days -> #3/#5 stay AT COST, no 0.00 subtotal", () => {
    const pulled = pullCalculatorValues({
      shippingData: data,
      inputs: {
        shippingLineId: dem.line.id,
        portId: port.id,
        terminalId: terminal.id,
        destinationId,
        containerTypeKey: containerKey,
        quantity: 1,
        demurrageDays: 0,
        storageDays: 0,
      },
      lineItems: buildInitialLineItems(),
      calculators,
      t,
    });
    const detention = findRow(pulled, "handover", "demurrage");
    const storage = findRow(pulled, "customs", "terminalStorage");
    assert.equal(detention.isAtCost, true, "detention stays AT COST at 0 days");
    assert.equal(String(detention.unitPrice).toUpperCase(), "AT COST", "detention unitPrice AT COST");
    assert.equal(storage.isAtCost, true, "storage stays AT COST at 0 days");
    const totals = computeQuoteTotals(pulled, { exchangeRates: data.exchangeRates });
    assert.ok(!totals.subtotals.some((s) => s.amount === 0), "no 0.00 currency subtotal");
    assert.ok(!totals.rows.some((r) => r.totalLabel === "0.00" && r.isAtCost), "no AT COST row showing 0.00");
  });

  // ---- B3: numbering increments + persists ----
  await record("B3 generateQuoteNumber format + increment + persist", async () => {
    const fresh = await getShippingData();
    const settings = fresh.modules.quote.settings;
    const g1 = generateQuoteNumber(settings);
    assert.match(g1.number, /^ELCMEX-SI-\d{3}E$/, "number format ELCMEX-SI-00NE");
    assert.equal(g1.nextSeq, settings.lastQuoteSeq + 1, "nextSeq increments");
    fresh.modules.quote.settings.lastQuoteSeq = g1.nextSeq;
    await saveShippingData(fresh);
    const reloaded = await getShippingData();
    assert.equal(reloaded.modules.quote.settings.lastQuoteSeq, g1.nextSeq, "lastQuoteSeq persisted");
    const g2 = generateQuoteNumber(reloaded.modules.quote.settings);
    assert.equal(g2.nextSeq, g1.nextSeq + 1, "subsequent number increments again");
  });

  // ---- B4: draft round-trip (JSON mode) ----
  await record("B4 draft round-trip persists via store", async () => {
    if (shouldUseDatabase()) {
      console.log("        (note: DB mode — draft still goes through app_state)");
    }
    const d = await getShippingData();
    const before = d.modules.quote.drafts.length;
    d.modules.quote.drafts.push({
      id: "q-roundtrip",
      number: "ELCMEX-SI-099E",
      date: "2026-06-13",
      header: { operation: "IMPORT", department: "OCEAN", incoterm: "CIF", pol: "CHINA", pod: "MANZANILLO", commodity: "x", cargoType: "FCL", delivery: "y" },
      lineItems: [{ category: "DUTY", conceptEn: "PEDIMENTO", conceptZh: "进口税金", unit: null, unitPrice: "AT COST", currency: "", remark: "", isAtCost: true, source: "atcost" }],
    });
    await saveShippingData(d);
    const reloaded = await getShippingData();
    assert.equal(reloaded.modules.quote.drafts.length, before + 1, "draft count grew");
    const found = reloaded.modules.quote.drafts.find((x) => x.number === "ELCMEX-SI-099E");
    assert.ok(found, "draft retrievable after reload");
    assert.equal(found.lineItems[0].conceptZh, "进口税金", "draft line item zh preserved");
  });

  // ---- B5: quote_snapshots (DB only) ----
  await record("B5 quote_snapshots insert/list (DB) or skip", async () => {
    if (!shouldUseDatabase()) {
      console.log("        skipped (JSON mode)");
      return;
    }
    const inserted = await insertQuoteSnapshot({
      moduleKey: "quote",
      businessNature: "IMPORT",
      input: { number: "ELCMEX-SI-TEST" },
      result: { subtotals: [] },
    });
    assert.ok(inserted && inserted.id, "snapshot inserted with id");
    const list = await listQuoteSnapshots(5);
    assert.ok(list.some((row) => String(row.id) === String(inserted.id)), "snapshot retrievable");
  });

  // ---- B6: mixed currency subtotals + indicative ----
  await record("B6 mixed-currency subtotals + indicative", () => {
    const items = [
      { category: "SHIPPING LINE", conceptEn: "A", conceptZh: "", unit: 1, unitPrice: 100, currency: "USD", remark: "", isAtCost: false, source: "manual" },
      { category: "PORT FEES", conceptEn: "B", conceptZh: "", unit: 2, unitPrice: 1000, currency: "MXN", remark: "", isAtCost: false, source: "manual" },
      { category: "CUSTOMS CLEARANCE", conceptEn: "C", conceptZh: "", unit: 1, unitPrice: 6000, currency: "MXN", remark: "", isAtCost: false, source: "manual" },
    ];
    const withFx = computeQuoteTotals(items, {
      exchangeRates: data.exchangeRates,
      showIndicativeConversion: true,
      indicativeCurrency: "MXN",
    });
    const cur = withFx.subtotals.map((s) => s.currency).sort();
    assert.deepEqual(cur, ["MXN", "USD"], "two per-currency subtotals");
    assert.equal(withFx.subtotals.find((s) => s.currency === "MXN").amount, 8000, "MXN subtotal 2*1000+6000");
    assert.equal(withFx.subtotals.find((s) => s.currency === "USD").amount, 100, "USD subtotal 100");
    assert.ok(withFx.indicative && withFx.indicative.amount > 8000, "indicative > MXN-only (adds converted USD)");
    const noFx = computeQuoteTotals(items, { exchangeRates: { pairs: [] }, showIndicativeConversion: true, indicativeCurrency: "MXN" });
    assert.equal(noFx.indicative, null, "indicative null without pairs, no throw");
  });

  // ---- B7: fee-code vocabulary ----
  await record("B7 loadFeeCodes returns 345 rows, DPCH resolves", () => {
    const codes = loadFeeCodes();
    assert.equal(codes.length, 345, "345 fee codes");
    const dpch = codes.find((c) => c.code === "DPCH");
    assert.ok(dpch && /destination port charges/i.test(dpch.description), "DPCH resolves to description");
  });

  // ---- B8: PDF smoke after pull ----
  await record("B8 renderQuotePdf returns a %PDF buffer", async () => {
    const pulled = pullCalculatorValues({
      shippingData: data,
      inputs: { shippingLineId: dem.line.id, portId: port.id, terminalId: terminal.id, destinationId, containerTypeKey: containerKey, quantity: 2, demurrageDays: 15, storageDays: 15 },
      lineItems: buildInitialLineItems(),
      calculators,
      t,
    });
    const totals = computeQuoteTotals(pulled, { exchangeRates: data.exchangeRates });
    const view = {
      number: "ELCMEX-SI-005E", date: "2026-06-13",
      header: { operation: "IMPORT", department: "OCEAN", incoterm: "CIF", pol: "CHINA", pod: "MANZANILLO", commodity: "General cargo", cargoType: "FCL", delivery: "Apodaca" },
      rows: totals.rows, groups: groupRowsForRender(totals.rows), subtotals: totals.subtotals, indicative: totals.indicative, notes: data.modules.quote.notes,
    };
    const pdf = await renderQuotePdf(view);
    assert.ok(Buffer.isBuffer(pdf) || pdf instanceof Uint8Array, "pdf is a buffer");
    assert.equal(Buffer.from(pdf.slice(0, 4)).toString(), "%PDF", "pdf starts with %PDF");
  });

  // ---- B10: all-AT-COST edge ----
  await record("B10 all AT COST -> empty subtotals, PDF still %PDF", async () => {
    const items = buildInitialLineItems().map((it) => ({ ...it, isAtCost: true, unitPrice: "AT COST" }));
    const totals = computeQuoteTotals(items, { exchangeRates: data.exchangeRates });
    assert.equal(totals.subtotals.length, 0, "no subtotals when all AT COST");
    const view = {
      number: "ELCMEX-SI-000E", date: "2026-06-13",
      header: { operation: "IMPORT", department: "OCEAN", incoterm: "CIF", pol: "CHINA", pod: "MANZANILLO", commodity: "", cargoType: "FCL", delivery: "" },
      rows: totals.rows, groups: groupRowsForRender(totals.rows), subtotals: totals.subtotals, indicative: null, notes: data.modules.quote.notes,
    };
    const pdf = await renderQuotePdf(view);
    assert.equal(Buffer.from(pdf.slice(0, 4)).toString(), "%PDF", "all-AT-COST pdf still %PDF");
  });

  await closeQuoteBrowser();

  const failed = results.filter(([ok]) => !ok);
  console.log(`\nquote-test: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log("quote-test-FAILED");
    process.exitCode = 1;
  } else {
    console.log("quote-test-ok");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch (_e) {
      /* ignore */
    }
  });
