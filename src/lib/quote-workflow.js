const {
  normalizeCargoPricing, normalizeCargoPricingByType, cargoPricingAttempted, calculateCargoPricing,
} = require("../../public/quote-pricing");

const CARGO_TYPES = ["FCL", "LCL", "BBK", "AIR"];
const array = (value) => Array.isArray(value) ? value : value === undefined ? [] : [value];
const cell = (body, name, index) => array(body[name])[index] ?? "";

function parseCargoPricing(body = {}, cargoType) {
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
    method: body.cargo_method, manualChargeable: body.cargo_manualChargeable ?? "",
    volumeDivisor: body.cargo_volumeDivisor ?? "",
  }, cargoType);
}

function parseCargoPricingByType(body = {}, activeType) {
  let stored = {};
  const errors = [];
  if (body.cargoPricingByType !== undefined) {
    if (typeof body.cargoPricingByType !== "string") {
      errors.push("cargoPricingByType:invalid_json");
    } else if (body.cargoPricingByType.length > 1024 * 1024) {
      errors.push("cargoPricingByType:too_large");
    } else {
      try { stored = JSON.parse(body.cargoPricingByType); }
      catch (_) { errors.push("cargoPricingByType:invalid_json"); }
    }
  }
  const byType = normalizeCargoPricingByType(stored);
  // Type-scoped map errors are derived below. Do not let an error previously
  // injected into the active calculation make a healthy type appear damaged on
  // the next submit, or survive after the damaged type is explicitly reset.
  errors.push(...(byType._validationErrors || []).filter((error) => !/^cargoPricingByType:(?:FCL|LCL|BBK|AIR):invalid_state$/.test(error)));
  delete byType._validationErrors;
  for (const type of CARGO_TYPES) {
    if (byType[type]?.validationErrors) {
      const localErrors = byType[type].validationErrors.filter((error) => !error.startsWith("cargoPricingByType:"));
      if (localErrors.length) byType[type].validationErrors = localErrors;
      else delete byType[type].validationErrors;
    }
  }
  if (CARGO_TYPES.includes(activeType)) {
    // The active inputs replace values, but a rendered normalized value is not
    // proof that rejected input was corrected. The editor removes a field's
    // prior error only after an explicit edit and sends that state in the map.
    const hasFields = Object.keys(body).some((name) => name.startsWith("cargo_"));
    if (hasFields || !byType[activeType]) {
      const priorErrors = byType[activeType]?.validationErrors || [];
      byType[activeType] = parseCargoPricing(body, activeType);
      if (priorErrors.length) {
        byType[activeType].validationErrors = [...new Set([...(byType[activeType].validationErrors || []), ...priorErrors])];
      }
    }
  }
  // Structural corruption in an inactive type must remain explicit; ordinary
  // incomplete descriptive values in that type do not prevent manual quotes.
  for (const type of CARGO_TYPES) {
    if ((byType[type]?.validationErrors || []).some((error) => /^pricing:/.test(error) || /:(?:invalid_rows|too_many_rows|invalid_row)$/.test(error))) {
      errors.push(`cargoPricingByType:${type}:invalid_state`);
    }
  }
  if (errors.length && CARGO_TYPES.includes(activeType)) {
    byType[activeType].validationErrors = [...new Set([...(byType[activeType].validationErrors || []), ...errors])];
  }
  if (errors.length) byType._validationErrors = [...new Set(errors)];
  return byType;
}

function cargoCalculation(cargoType, pricing) {
  const normalized = normalizeCargoPricing(pricing, cargoType);
  return { ...calculateCargoPricing(cargoType, normalized), attempted: cargoPricingAttempted(cargoType, normalized) };
}

function buildCargoChargeRows(cargoType, calculation) {
  if (!calculation.attempted || !calculation.valid) return [];
  const sourceRows = cargoType === "FCL" ? calculation.rows : [{
    quantity: calculation.chargeableValue, unitPrice: calculation.unitPrice,
    currency: calculation.currency,
  }];
  const remark = calculation.method === "manual"
    ? `Manual chargeable quantity = ${calculation.chargeableValue}`
    : calculation.method === "volumetric"
      ? `max(${calculation.totalWeightKg} kg, ${calculation.totalVolumeCm3} cm³ / ${calculation.volumeDivisor} cm³/kg) = ${calculation.chargeableValue} kg`
      : `max(${calculation.totalWeightKg} kg, ${calculation.totalVolumeCm3} cm³) = ${calculation.chargeableValue}`;
  return sourceRows.map((row, index) => ({
    id: `cargo-calculated-${index + 1}`, code: "", category: "TRANSPORTATION",
    conceptEn: `Cargo transport ${cargoType}${row.containerType ? ` ${row.containerType}` : ""}`,
    conceptZh: `运输计费 ${cargoType}${row.containerType ? ` ${row.containerType}` : ""}`,
    conceptEs: `Transporte ${cargoType}${row.containerType ? ` ${row.containerType}` : ""}`,
    section: "mexico", chargeKind: "fixed", included: true, unitPriceMax: null,
    appliesTo: [cargoType], unit: row.quantity, unitPrice: row.unitPrice,
    unitOfMeasure: cargoType === "FCL" ? "container" : "chargeable", currency: row.currency,
    remark: cargoType === "FCL" ? "" : remark,
    source: "cargo_pricing", isCargoCharge: true, isAtCost: false, calcRef: null,
  }));
}

// A retired/custom type has no current pricing workflow. Only a real saved
// draft can retain that original type and its manually priced snapshot rows.
// Never derive this exception from an untrusted form flag or cargo type alone.
function historicalQuoteCargoType(quoteModule, draftId) {
  if (typeof draftId !== "string" || !draftId) return "";
  const draft = (quoteModule.drafts || []).find((entry) => entry.id === draftId);
  const type = draft?.header?.cargoType;
  return typeof type === "string" && type && !CARGO_TYPES.includes(type) ? type : "";
}

function activeQuoteRows(rows, quoteMode, cargoType, historicalCargoType = "") {
  const keepHistoricalRows = Boolean(historicalCargoType) && cargoType === historicalCargoType && !CARGO_TYPES.includes(cargoType);
  return rows.filter((row) => (quoteMode === "ocean_mexico" || row.section !== "foreign") &&
    (keepHistoricalRows || !cargoType || !Array.isArray(row.appliesTo) || row.appliesTo.includes(cargoType)));
}

module.exports = { parseCargoPricing, parseCargoPricingByType, normalizeCargoPricingByType, cargoCalculation, buildCargoChargeRows, activeQuoteRows, historicalQuoteCargoType };
