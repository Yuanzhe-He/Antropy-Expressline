// Batch3 focused tests: P0 quote-header normalizer parity + S1 precise flatPrice
// + S3 conceptEs round-trip. Run: node scripts/r2-batch3-test.js
const assert = require("node:assert/strict");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";

const { normalizeShippingData } = require("../src/lib/store");

function p0HeaderParity() {
  const out = normalizeShippingData({
    modules: {
      quote: {
        drafts: [
          {
            id: "q-1",
            number: "X",
            date: "2026-06-17",
            header: {
              operation: "EXPORT",
              department: "INLAND",
              transportMode: "RAI",
              incoterm: "FOB",
              cargoType: "BBK",
              pol: "CHINA",
              pod: "MZO",
              commodity: "G",
              delivery: "CDMX",
              extraFields: [{ label: "REF", value: "ABC" }],
            },
            lineItems: [],
          },
          {
            id: "q-old",
            number: "Y",
            date: "2026-06-17",
            header: { operation: "IMPORT", department: "OCEAN", cargoType: "FCL" },
            lineItems: [],
          },
        ],
      },
    },
  });
  const d = out.modules.quote.drafts[0].header;
  assert.equal(d.department, "INLAND", "INLAND department survives draft round-trip");
  assert.equal(d.cargoType, "BBK", "new cargo type survives");
  assert.equal(d.transportMode, "RAI", "transportMode survives");
  assert.equal(d.incoterm, "FOB", "incoterm survives");
  assert.equal(d.extraFields.length, 1, "extraFields survive");
  const old = out.modules.quote.drafts[1].header;
  assert.equal(old.department, "OCEAN", "old draft OCEAN preserved");
  assert.equal(old.cargoType, "FCL", "old draft FCL preserved");
  assert.equal(old.transportMode, "", "old draft transportMode defaults empty (back-compat)");
}

function s3ConceptEsRoundTrip() {
  const out = normalizeShippingData({
    modules: {
      quote: {
        drafts: [
          {
            id: "q-es",
            number: "Z",
            date: "2026-06-17",
            header: { operation: "IMPORT" },
            lineItems: [
              { id: "li-1", conceptEn: "FREIGHT", conceptZh: "运费", conceptEs: "Flete", unit: 1, unitPrice: 10, currency: "USD" },
              { id: "li-2", conceptEn: "OLD ROW" }, // pre-batch3 row: no conceptEs
            ],
          },
        ],
      },
    },
  });
  const items = out.modules.quote.drafts[0].lineItems;
  assert.equal(items[0].conceptEs, "Flete", "conceptEs survives draft round-trip");
  assert.equal(items[1].conceptEs, "", "old line item conceptEs defaults empty (back-compat)");
}

function s1FlatPriceRoundTrip() {
  const out = normalizeShippingData({
    modules: {
      inland: {
        settings: { inlandSeedVersion: 9999 }, // keep our test destinations (skip reseed)
        origins: [{ id: "manzanillo", name: "Manzanillo", lat: 19, lng: -104 }],
        destinations: [
          {
            id: "apodaca",
            name: "Apodaca",
            lat: 25.78,
            lng: -100.18,
            precisePoints: [
              { id: "pp-1", name: "CF Moto", lat: 25.8, lng: -100.2, flatPrice: 42000 },
              { id: "pp-2", name: "No flat", lat: 25.81, lng: -100.21 },
            ],
          },
        ],
        rateEntries: [],
      },
    },
  });
  const pts = out.modules.inland.destinations[0].precisePoints;
  assert.equal(pts[0].flatPrice, 42000, "precise-point flatPrice survives");
  assert.equal(pts[1].flatPrice, null, "precise-point without flat defaults null (inherits city rate)");
}

p0HeaderParity();
s1FlatPriceRoundTrip();
if (process.env.BATCH3_S3) s3ConceptEsRoundTrip(); // enabled once S3 lands
console.log("r2-batch3-test-ok");
