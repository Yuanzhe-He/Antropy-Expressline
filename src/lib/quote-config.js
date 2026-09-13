"use strict";

const QUOTE_CONFIG_VERSION = 1;
const QUOTE_FEE_CATEGORIES = Object.freeze([
  "OCEAN FREIGHT", "PORT OF ORIGIN", "SHIPPING LINE", "PORT FEES",
  "CUSTOMS CLEARANCE", "TRANSPORTATION", "DUTY",
]);
const DEFAULT_CURRENCY_BY_CATEGORY = Object.freeze(Object.fromEntries(
  QUOTE_FEE_CATEGORIES.map((category) => [category, category === "SHIPPING LINE" ? "USD" : "MXN"]),
));
const CURRENCIES = ["USD", "MXN"];
const CARGO_TYPES = ["FCL", "LCL", "BBK"];
const MAX_ROWS = 100;
const SOURCE_NOTE = "User screenshot received 2026-09-13: CY-Door 港到门 / 正清墨西哥清关送货, 40HQ column. Reference prices and conditions pending Bill review; not a carrier tariff.";

function getQuoteDefaultCurrency(category, settings = {}) {
  const values = settings && typeof settings === "object"
    ? (settings.defaultCurrencyByCategory || settings) : {};
  const value = Object.prototype.hasOwnProperty.call(values, category) ? values[category] : "";
  return CURRENCIES.includes(value) ? value : (DEFAULT_CURRENCY_BY_CATEGORY[category] || "MXN");
}

function template(id, category, conceptEn, conceptZh, price, currency, unitOfMeasure, remark, extra = {}) {
  const row = {
    id, code: id.toUpperCase().replace(/-/g, "_"), category, conceptEn, conceptZh,
    conceptEs: "", section: "mexico", unit: 1, defaultQuantity: 1,
    unitOfMeasure, unitPrice: price, unitPriceMax: null, currency,
    remark, isAtCost: false, source: "manual", calcRef: null,
    chargeKind: "fixed", appliesTo: unitOfMeasure === "container" ? ["FCL"] : [...CARGO_TYPES],
    enabled: true, selectionRequired: false, sourceNote: SOURCE_NOTE,
    ...extra,
  };
  Object.freeze(row.appliesTo);
  return Object.freeze(row);
}

// Directly read from the user-provided screenshot, including its explicit
// currency exceptions, ranges, quantities, and conditional remarks. Optional
// alternatives remain selectable templates, not automatically stacked charges.
const DEFAULT_QUOTE_FEE_TEMPLATES = Object.freeze([
  template("pre-inspection", "CUSTOMS CLEARANCE", "Pre-inspection Fee", "预检费", 350, "USD", "container",
    "Recommended, speeds up customs clearance. 建议做，加速通关。", { selectionRequired: true }),
  template("delivery-order", "SHIPPING LINE", "Delivery Order Fee", "船公司 LOCAL", 190, "USD", "container",
    "Actual cost, shipping line invoice to be provided. 实报实销，提供船司发票。"),
  template("destination-handling", "SHIPPING LINE", "Destination Handling Fee", "换单费", 2000, "MXN", "bl",
    "Including AMS fee (AMS filing to the Mexican tax authority, not the AMS filed by origin booking). 含 AMS 费用，这个 AMS 不是国内订舱发的 AMS，是向墨西哥税局申报的 AMS。"),
  template("customs-service", "CUSTOMS CLEARANCE", "Customs Clearance Service Fee", "HONORARIOS（清关服务费）", 7000, "MXN", "container",
    "Multiple customs declarations per container will be charged separately. 如一个集装箱涉及多份报关单，则按实际报关单数量分别计费。"),
  template("mv-filing", "CUSTOMS CLEARANCE", "MV Electronic Filing Fee", "MV 电子货值申报费", 1500, "MXN", "container",
    "Fee applies if we handle the declaration; no fee if you do it yourself. 如贵司委托我司申报则收取，贵司自己申报则不收取。", { selectionRequired: true }),
  template("terminal-handling", "PORT FEES", "Terminal Handling Fee", "码头费", 16000, "MXN", "container",
    "Estimated cost. Actual cost, terminal invoice to be provided. 报价费用为预估，实报实销，提供码头发票。"),
  template("transport-single", "TRANSPORTATION", "Transportation (Single)", "拖车费（Single）", 53000, "MXN", "container",
    "Single, cargo weight ≤ 21 tons. 单拖，货重 21 吨以下。", { selectionRequired: true }),
  template("transport-full", "TRANSPORTATION", "Transportation (Full)", "拖车费（Full）", 75000, "MXN", "container",
    "Full, cargo weight ≤ 20 tons. 双拖，货重 20 吨以下。", { unit: 2, defaultQuantity: 2, selectionRequired: true }),
  template("container-cleaning", "SHIPPING LINE", "Container Cleaning Fee", "集装箱清洁费", 800, "MXN", "container",
    "Charged by the shipping line designated yard, depending on container condition. Usually MXN 800–2,000/container before VAT. 由船公司指定堆场收取，具体费用根据集装箱实际状况确定，通常为 800–2,000 墨西哥比索/柜（未含税）。",
    { chargeKind: "contingent", unitPriceMax: 2000 }),
  template("customs-inspection", "CUSTOMS CLEARANCE", "Customs Inspection Fee", "海关查验费", 8000, "MXN", "container",
    "海关查验费由码头收取，金额未含税。Charged by the terminal before VAT.",
    { chargeKind: "contingent", unitPriceMax: 10000, sourceNote: `${SOURCE_NOTE} Price column: 8,000–10,000; original remark: 8000–1000. Bill to confirm the discrepancy.` }),
  template("terminal-to-yard", "TRANSPORTATION", "Operation Fee from Terminal to Container Yard", "码头到堆场的操作费", 9000, "MXN", "container",
    "Temporary storage at the truck yard if the container cannot be received. Includes terminal-to-yard drayage and yard handlings. 集装箱从码头提出后，如贵司暂时无法收货，暂存于车队堆场。该费用包含码头至堆场短驳费及堆场操作费。",
    { chargeKind: "contingent" }),
  template("empty-run-single", "TRANSPORTATION", "Single Truck Empty Run Fee", "单拖空放费", 6000, "MXN", "container",
    "Truck empty run fee if pickup fails due to terminal closure or other terminal issues. 车队按预约时间（CITA）前往码头提柜，如因码头提前关闭等原因导致提柜失败，产生的车辆空放费用。",
    { chargeKind: "contingent" }),
  template("empty-run-double", "TRANSPORTATION", "Double Truck Empty Run Fee", "双拖空放费", 10000, "MXN", "container",
    "Truck empty run fee if pickup fails due to terminal closure or other terminal issues. 车队按预约时间（CITA）前往码头提柜，如因码头提前关闭等原因导致提柜失败，产生的车辆空放费用。",
    { chargeKind: "contingent", unit: 2, defaultQuantity: 2 }),
  template("truck-waiting", "TRANSPORTATION", "Truck Waiting Time Fee", "卡车待时费", 6000, "MXN", "day",
    "Free for the first 8 hours. 8 小时内免费。", { chargeKind: "contingent", appliesTo: ["FCL"] }),
]);

function safeText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function numeric(value) {
  if (value === "" || value == null || (typeof value !== "string" && typeof value !== "number")) return null;
  if (typeof value === "string" && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER / 100 ? parsed : null;
}

function normalizeRow(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = safeText(entry.id, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) return null;
  const category = safeText(entry.category, 40);
  if (!QUOTE_FEE_CATEGORIES.includes(category)) return null;
  const conceptEn = safeText(entry.conceptEn, 200);
  const conceptZh = safeText(entry.conceptZh, 200);
  if (!conceptEn && !conceptZh) return null;
  const defaultQuantity = numeric(entry.defaultQuantity == null ? entry.unit : entry.defaultQuantity);
  const upper = numeric(entry.unitPriceMax);
  const lower = numeric(entry.unitPrice);
  return {
    id, code: safeText(entry.code, 100), category, conceptEn, conceptZh,
    conceptEs: safeText(entry.conceptEs, 200), section: entry.section === "foreign" ? "foreign" : "mexico",
    unit: defaultQuantity === null ? "" : defaultQuantity,
    defaultQuantity: defaultQuantity === null ? "" : defaultQuantity,
    unitOfMeasure: safeText(entry.unitOfMeasure, 40) || "container",
    unitPrice: lower === null ? "" : lower, unitPriceMax: upper,
    currency: CURRENCIES.includes(entry.currency) ? entry.currency : getQuoteDefaultCurrency(category),
    remark: safeText(entry.remark, 3000), isAtCost: entry.isAtCost === true,
    source: ["manual", "calc", "atcost"].includes(entry.source) ? entry.source : "manual",
    calcRef: entry.calcRef && typeof entry.calcRef === "object" && !Array.isArray(entry.calcRef)
      ? { module: safeText(entry.calcRef.module, 40), field: safeText(entry.calcRef.field, 80) } : null,
    chargeKind: entry.chargeKind === "contingent" ? "contingent" : "fixed",
    appliesTo: Array.isArray(entry.appliesTo) ? [...new Set(entry.appliesTo.filter((type) => CARGO_TYPES.includes(type)))] : [...CARGO_TYPES],
    enabled: entry.enabled === true, selectionRequired: entry.selectionRequired === true,
    sourceNote: safeText(entry.sourceNote, 2000),
  };
}

function normalizeQuoteFeeTemplates(value) {
  // An explicit [] means no configured templates; never resurrect deleted rows.
  const input = Array.isArray(value) ? value : DEFAULT_QUOTE_FEE_TEMPLATES;
  const ids = new Set();
  const rows = [];
  for (const entry of input.slice(0, MAX_ROWS)) {
    const row = normalizeRow(entry);
    if (!row || ids.has(row.id)) continue;
    ids.add(row.id);
    rows.push(row);
  }
  return rows;
}

function validateQuoteFeeTemplates(value) {
  if (!Array.isArray(value) || value.length > MAX_ROWS) return "invalid_fee_templates";
  const ids = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "invalid_fee_template";
    if (typeof entry.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(entry.id)) return "invalid_fee_template_id";
    if (ids.has(entry.id)) return "duplicate_fee_template_id";
    ids.add(entry.id);
    const validLabel = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 200;
    if (!validLabel(entry.conceptEn) && !validLabel(entry.conceptZh)) return "invalid_fee_template_label";
    if (![entry.conceptEn, entry.conceptZh, entry.conceptEs].every((value) => value == null || (typeof value === "string" && value.length <= 200))) return "invalid_fee_template_label";
    if (!QUOTE_FEE_CATEGORIES.includes(entry.category)) return "invalid_fee_template_category";
    if (!CURRENCIES.includes(entry.currency)) return "invalid_fee_template_currency";
    if (!["fixed", "contingent"].includes(entry.chargeKind)) return "invalid_fee_template_charge_kind";
    if (typeof entry.enabled !== "boolean") return "invalid_fee_template_enabled";
    if (entry.selectionRequired != null && typeof entry.selectionRequired !== "boolean") return "invalid_fee_template_selection";
    if (!Array.isArray(entry.appliesTo) || !entry.appliesTo.length || entry.appliesTo.some((type) => !CARGO_TYPES.includes(type))) return "invalid_fee_template_cargo_types";
    const price = numeric(entry.unitPrice);
    if (price === null && entry.unitPrice !== "" && entry.unitPrice != null && !(entry.isAtCost && entry.unitPrice === "AT COST")) return "invalid_fee_template_price";
    const max = numeric(entry.unitPriceMax);
    if (entry.unitPriceMax !== "" && entry.unitPriceMax != null && max === null) return "invalid_fee_template_price_range";
    if (max !== null && (price === null || max < price)) return "invalid_fee_template_price_range";
    const quantity = entry.defaultQuantity == null ? entry.unit : entry.defaultQuantity;
    if (quantity !== "" && quantity != null && numeric(quantity) === null) return "invalid_fee_template_quantity";
    if (entry.unitOfMeasure != null && (typeof entry.unitOfMeasure !== "string" || entry.unitOfMeasure.length > 40)) return "invalid_fee_template_unit";
    if (entry.remark != null && (typeof entry.remark !== "string" || entry.remark.length > 3000)) return "invalid_fee_template_remark";
    if (entry.sourceNote != null && (typeof entry.sourceNote !== "string" || entry.sourceNote.length > 2000)) return "invalid_fee_template_source";
  }
  return "";
}

module.exports = {
  QUOTE_CONFIG_VERSION,
  QUOTE_FEE_CATEGORIES,
  DEFAULT_CURRENCY_BY_CATEGORY,
  getQuoteDefaultCurrency,
  DEFAULT_QUOTE_FEE_TEMPLATES,
  normalizeQuoteFeeTemplates,
  validateQuoteFeeTemplates,
};
