// Generate a sample Cotización (quote) document for review / meetings.
// Read-only: pulls real shipping data (prod DB when configured, else local seed),
// runs the existing quote pipeline unchanged, and writes HTML (always) + PDF
// (when Chromium is available) to docs/specs/sample-quote-<dest>.{html,pdf}.
//
// Usage: node scripts/quote-sample.js [destinationId=apodaca]

const fs = require("node:fs");
const path = require("node:path");
const { getShippingData, normalizeShippingData } = require("../src/lib/store");
const {
  computeHandoverCalculator,
  computeCustomsCalculator,
  computeInlandCalculator,
} = require("../src/lib/calculate");
const {
  buildInitialLineItems,
  computeQuoteTotals,
  pullCalculatorValues,
  groupRowsForRender,
  generateQuoteNumber,
  resolveQuoteRoute,
  DEFAULT_QUOTE_HEADER,
  QUOTE_NOTES,
} = require("../src/lib/quote");
const {
  renderQuoteHtml,
  renderQuotePdf,
  closeQuoteBrowser,
} = require("../src/lib/quote-pdf");

async function loadShippingData() {
  try {
    const data = await getShippingData();
    return { data, source: "configured store (prod DB / JSON per env)" };
  } catch (error) {
    // Network/DB unreachable from this environment — fall back to the local seed
    // so a sample can still be produced. Clearly flagged in the output.
    const raw = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../data/shipping-lines.json"), "utf8")
    );
    return {
      data: normalizeShippingData(raw),
      source: `local data/shipping-lines.json (store unavailable: ${String(error.message).split("\n")[0]})`,
    };
  }
}

async function main() {
  const destinationId = (process.argv[2] || "apodaca").trim();
  const { data: shippingData, source } = await loadShippingData();
  console.log(`Data source: ${source}`);

  const quoteModule = shippingData.modules.quote;
  const inland = shippingData.modules.inland;
  const dest = (inland.destinations || []).find((d) => d.id === destinationId);
  if (!dest) {
    console.error(`Destination not found: ${destinationId}`);
    process.exit(1);
  }

  const lineItems = buildInitialLineItems();
  const pullInputs = {
    shippingLineId: "", // fallback -> first line
    portId: "", // fallback -> first port (Manzanillo)
    terminalId: "",
    destinationId,
    containerTypeKey: "",
    quantity: 1,
    demurrageDays: 25, // > 21 free days -> demurrage row populates
    storageDays: 10, // > free storage -> terminal storage row populates
  };
  const items = pullCalculatorValues({
    shippingData,
    inputs: pullInputs,
    lineItems,
    calculators: {
      computeHandoverCalculator,
      computeCustomsCalculator,
      computeInlandCalculator,
    },
  });

  const totals = computeQuoteTotals(items, {
    exchangeRates: shippingData.exchangeRates,
    showIndicativeConversion: true,
    indicativeCurrency: quoteModule.settings.indicativeCurrency || "MXN",
    // R4 dual-currency: MXN sin IVA + USD con 16% IVA (defaults).
    dualCurrency: true,
    ivaMxn: 0,
    ivaUsd: 0.16,
  });

  const quoteView = {
    number: generateQuoteNumber(quoteModule.settings).number,
    date: new Date().toISOString().slice(0, 10),
    header: {
      ...DEFAULT_QUOTE_HEADER,
      pod: "MANZANILLO",
      commodity: "General container cargo / 一般集装箱货物",
      delivery: `${dest.name}${dest.state ? ", " + dest.state : ""}, México`,
    },
    rows: totals.rows,
    groups: groupRowsForRender(totals.rows),
    subtotals: totals.subtotals,
    indicative: totals.indicative,
    dualTotals: totals.dualTotals,
    route: resolveQuoteRoute(inland, destinationId),
    // Show the K5 provisional dual-currency note wording in the sample.
    notes: QUOTE_NOTES,
  };

  const outDir = path.join(__dirname, "../docs/specs");
  const base = `sample-quote-${destinationId}`;

  const html = await renderQuoteHtml(quoteView);
  fs.writeFileSync(path.join(outDir, `${base}.html`), html);
  console.log(`HTML written: docs/specs/${base}.html`);

  try {
    const pdf = await renderQuotePdf(quoteView);
    fs.writeFileSync(path.join(outDir, `${base}.pdf`), pdf);
    console.log(`PDF written:  docs/specs/${base}.pdf (${pdf.length} bytes)`);
  } catch (error) {
    console.log(
      `PDF skipped (Chromium unavailable): ${String(error.message).split("\n")[0]}`
    );
  } finally {
    await closeQuoteBrowser();
  }

  console.log(`\nQuote ${quoteView.number} -> ${dest.name}`);
  console.log("Priced rows:");
  for (const r of totals.rows) {
    if (r.total !== null) {
      console.log(
        `  ${r.category.padEnd(18)} | ${r.conceptEn}: ${r.unitPriceLabel} x ${r.unit} = ${r.totalLabel} ${r.currency}`
      );
    }
  }
  console.log(
    "Subtotals:",
    totals.subtotals.map((s) => `${s.amountLabel} ${s.currency}`).join(" | ") || "(all AT COST)"
  );
  if (totals.indicative) {
    console.log(`Indicative: ${totals.indicative.amountLabel} ${totals.indicative.currency}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
