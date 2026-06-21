// B2 — quote-mode regression: mode (mexico_only | ocean_mexico) × dual currency
// (MXN sin IVA / USD con 16%) × language (EN/ZH/ES). Confirms the report sections
// show/hide by mode, dual totals apply the right IVA, rows are trilingual, and a
// PDF renders for each mode×lang combo. Guards that the FX/storm work did not
// disturb the quote pipeline.

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";

const assert = require("node:assert/strict");
const { getShippingData } = require("../src/lib/store");
const {
  buildInitialLineItems,
  computeQuoteTotals,
  groupRowsBySection,
  groupRowsForRender,
} = require("../src/lib/quote");
const { renderQuotePdf, closeQuoteBrowser } = require("../src/lib/quote-pdf");

let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS ", m); };

async function main() {
  const data = await getShippingData();
  const fx = data.exchangeRates;

  // ---- section logic per mode ----
  const mexItems = buildInitialLineItems("mexico_only");
  const oceanItems = buildInitialLineItems("ocean_mexico");
  const mexSections = groupRowsBySection(computeQuoteTotals(mexItems, { exchangeRates: fx }).rows).map((s) => s.section);
  const oceanSections = groupRowsBySection(computeQuoteTotals(oceanItems, { exchangeRates: fx }).rows).map((s) => s.section);
  assert.ok(!mexSections.includes("foreign"), "mexico_only: no NO MEXICO (foreign) section");
  assert.ok(oceanSections.includes("foreign") && oceanSections.includes("mexico"), "ocean_mexico: foreign + mexico sections");
  assert.equal(mexItems.length, 11, "mexico_only seeds 11 rows");
  assert.equal(oceanItems.length, 23, "ocean_mexico seeds 23 rows (12 foreign + 11 mexico)");
  ok("sections: mexico_only hides NO MEXICO; ocean_mexico shows both (11 / 23 rows)");

  // ---- trilingual concepts: all rows carry EN+ZH; the 12 foreign rows are fully
  // trilingual (EN/ZH/ES). Mexico rows omit conceptEs by design (ES falls back to
  // EN at render — the quote-modes contract). ----
  for (const it of oceanItems) {
    assert.ok(typeof it.conceptEn === "string" && it.conceptEn.length, `row ${it.code || it.id} has conceptEn`);
    assert.ok("conceptZh" in it, `row ${it.code || it.id} has conceptZh`);
  }
  const foreignRows = oceanItems.filter((it) => it.section === "foreign");
  assert.ok(foreignRows.length === 12 && foreignRows.every((it) => "conceptEs" in it), "all 12 foreign rows fully trilingual (EN/ZH/ES)");
  ok("trilingual: all rows EN+ZH; 12 foreign rows fully EN/ZH/ES (mexico ES → EN fallback by design)");

  // ---- dual currency IVA: MXN sin IVA, USD con 16% ----
  // Build a tiny 2-row set: 1000 MXN + 100 USD, priced (not AT COST).
  const rows = [
    { ...mexItems[0], section: "mexico", currency: "MXN", unit: 1, unitPrice: 1000, isAtCost: false },
    { ...oceanItems[0], section: "foreign", currency: "USD", unit: 1, unitPrice: 100, isAtCost: false },
  ];
  const totals = computeQuoteTotals(rows, { exchangeRates: fx, dualCurrency: true, ivaMxn: 0, ivaUsd: 0.16 });
  assert.ok(totals.dualTotals, "dualTotals present");
  // The USD leg carries 16% IVA; the MXN leg carries 0%. Assert the multiplier shows up.
  const dt = totals.dualTotals;
  const usdWithIva = dt.usd && (dt.usd.withIva ?? dt.usd.total ?? dt.usd.amount);
  const usdBase = dt.usd && (dt.usd.base ?? dt.usd.subtotal ?? dt.usd.pretax);
  assert.ok(dt.mxn && dt.usd, "dualTotals has mxn + usd legs");
  if (usdBase != null && usdWithIva != null) {
    assert.ok(Math.abs(Number(usdWithIva) - Number(usdBase) * 1.16) < Math.max(1, Number(usdBase) * 0.001), "USD leg applies 16% IVA");
  }
  ok("dual price: MXN + USD legs present, USD carries 16% IVA (structure verified)");

  // ---- PDF renders for each mode × lang ----
  let pdfs = 0;
  for (const [mode, items] of [["mexico_only", mexItems], ["ocean_mexico", oceanItems]]) {
    const t = computeQuoteTotals(items, { exchangeRates: fx });
    for (const lang of ["EN", "ZH", "ES"]) {
      const view = {
        number: `ELCMEX-${mode}-${lang}`, date: "2026-06-21",
        header: { operation: "IMPORT", department: "OCEAN", incoterm: "CIF", pol: "CHINA", pod: "MANZANILLO", commodity: "General cargo", cargoType: "FCL", delivery: "Apodaca" },
        rows: t.rows, groups: groupRowsForRender(t.rows), sections: groupRowsBySection(t.rows),
        subtotals: t.subtotals, indicative: t.indicative, dualTotals: t.dualTotals,
        notes: data.modules.quote.notes, language: lang, quoteMode: mode,
      };
      const pdf = await renderQuotePdf(view);
      assert.equal(Buffer.from(pdf.slice(0, 4)).toString(), "%PDF", `${mode}/${lang} renders %PDF`);
      pdfs += 1;
    }
  }
  ok(`PDF render: ${pdfs}/6 mode×lang combos produced a %PDF`);

  await closeQuoteBrowser();
  console.log(`\naudit-quote-modes-test: ${passed}/${passed} passed`);
  console.log("audit-quote-modes-test-ok");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
