const { normalizeCargoPricing, calculateCargoPricing } = require("../../public/quote-pricing");

const array = (value) => Array.isArray(value) ? value : value === undefined ? [] : [value];
const cell = (body, name, index) => array(body[name])[index] ?? "";

function parseCargoPricing(body = {}) {
  const rowsFor = (names) => Array.from({ length: Math.min(101, Math.max(0, ...names.map((name) => array(body[name]).length))) });
  return normalizeCargoPricing({
    containers: rowsFor(["cargo_containerType", "cargo_containerQuantity", "cargo_containerPrice", "cargo_containerCurrency"]).map((_, i) => ({
      containerType: cell(body, "cargo_containerType", i), quantity: cell(body, "cargo_containerQuantity", i),
      unitPrice: cell(body, "cargo_containerPrice", i), currency: cell(body, "cargo_containerCurrency", i),
    })),
    packages: rowsFor(["cargo_lengthCm", "cargo_widthCm", "cargo_heightCm", "cargo_packageCount", "cargo_weightKg", "cargo_weightCount"]).map((_, i) => ({
      lengthCm: cell(body, "cargo_lengthCm", i), widthCm: cell(body, "cargo_widthCm", i), heightCm: cell(body, "cargo_heightCm", i),
      packageCount: cell(body, "cargo_packageCount", i), weightKg: cell(body, "cargo_weightKg", i),
      weightCount: cell(body, "cargo_weightCount", i),
    })),
    unitPrice: body.cargo_unitPrice ?? "", currency: body.cargo_currency ?? "",
  });
}

function cargoCalculation(cargoType, pricing) {
  const normalized = normalizeCargoPricing(pricing);
  const present = (value) => value !== "" && value !== undefined && value !== null;
  const activeErrors = (normalized.validationErrors || []).filter((error) => cargoType === "FCL"
    ? error.startsWith("containers") : ["LCL", "BBK"].includes(cargoType) && !error.startsWith("containers"));
  const attempted = activeErrors.length > 0 || (cargoType === "FCL"
    ? normalized.containers.some((row) => [row.containerType, row.quantity, row.unitPrice].some(present))
    : ["LCL", "BBK"].includes(cargoType) && (present(normalized.unitPrice) || normalized.packages.some((row) => Object.values(row).some(present))));
  return { ...calculateCargoPricing(cargoType, normalized), attempted };
}

function buildCargoChargeRows(cargoType, calculation) {
  if (!calculation.attempted || !calculation.valid) return [];
  const sourceRows = cargoType === "FCL" ? calculation.rows : [{
    quantity: calculation.chargeableValue, unitPrice: calculation.unitPrice,
    currency: calculation.currency,
  }];
  return sourceRows.map((row, index) => ({
    id: `cargo-calculated-${index + 1}`, code: "CARGO", category: "TRANSPORTATION",
    conceptEn: `Cargo transport ${cargoType}${row.containerType ? ` ${row.containerType}` : ""}`,
    conceptZh: `运输计费 ${cargoType}${row.containerType ? ` ${row.containerType}` : ""}`,
    conceptEs: `Transporte ${cargoType}${row.containerType ? ` ${row.containerType}` : ""}`,
    section: "mexico", chargeKind: "fixed", included: true, unitPriceMax: null,
    appliesTo: [cargoType], unit: row.quantity, unitPrice: row.unitPrice,
    unitOfMeasure: cargoType === "FCL" ? "container" : "chargeable", currency: row.currency,
    remark: cargoType === "FCL" ? "" : `max(${calculation.totalWeightKg} kg, ${calculation.totalVolumeCm3} cm³) = ${calculation.chargeableValue}`,
    source: "cargo_pricing", isCargoCharge: true, isAtCost: false, calcRef: null,
  }));
}

function activeQuoteRows(rows, quoteMode, cargoType) {
  return rows.filter((row) => (quoteMode === "ocean_mexico" || row.section !== "foreign") &&
    (!cargoType || !Array.isArray(row.appliesTo) || row.appliesTo.includes(cargoType)));
}

module.exports = { parseCargoPricing, cargoCalculation, buildCargoChargeRows, activeQuoteRows };
