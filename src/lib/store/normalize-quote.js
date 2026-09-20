// store/normalize-quote: quote module normalizer (settings / header defaults /
// drafts / line items / notes). Imports ./shared only.

const {
  normalizeCurrencyCode,
} = require("../options");
const {
  DEFAULT_QUOTE_HEADER,
  QUOTE_DEPARTMENT_OPTIONS,
  QUOTE_GROUP_ORDER,
  QUOTE_INCOTERM_OPTIONS,
  QUOTE_NOTES,
  QUOTE_TEMPLATE_ROWS,
  QUOTE_TEMPLATE_VERSION,
  QUOTE_TRANSPORT_MODE_OPTIONS,
  normalizeQuoteMode,
  normalizeQuoteCargoCode,
  normalizeQuoteCargoTypes,
} = require("../quote");
const {
  parseNumber,
  slugifyId,
} = require("./shared");
const { normalizeCargoPricing, normalizeCargoPricingByType } = require("../../../public/quote-pricing");
const { QUOTE_CONFIG_VERSION, DEFAULT_QUOTE_FEE_TEMPLATES, DEFAULT_CURRENCY_BY_CATEGORY, normalizeQuoteFeeTemplates, normalizeCargoPricingRules } = require("../quote-config");

function normalizeQuoteLineItem(item = {}, fallbackId) {
  const atCost =
    Boolean(item.isAtCost) ||
    String(item.unitPrice ?? "").trim().toUpperCase() === "AT COST";
  const cur = String(item.currency || "").trim().toUpperCase();
  const currency = cur === "USD" ? "USD" : cur === "MXN" ? "MXN" : atCost ? "" : "MXN";
  const source = ["calc", "manual", "atcost"].includes(item.source)
    ? item.source
    : atCost
      ? "atcost"
      : "manual";
  const calcRef =
    item.calcRef &&
    typeof item.calcRef === "object" &&
    item.calcRef.module &&
    item.calcRef.field
      ? { module: String(item.calcRef.module), field: String(item.calcRef.field) }
      : null;
  return {
    id: slugifyId(item.id, fallbackId),
    code: String(item.code || "").trim(),
    category: QUOTE_GROUP_ORDER.includes(item.category)
      ? item.category
      : QUOTE_GROUP_ORDER[0],
    conceptEn: String(item.conceptEn || "").trim(),
    conceptZh: String(item.conceptZh || "").trim(),
    // S3 (batch3): ES concept for single-language ES output. Also persist the
    // Q7.3 section / unitOfMeasure here so drafts don't lose them (same class of
    // gap as the P0 header fix). Back-compat: missing -> "" / "mexico".
    conceptEs: String(item.conceptEs || "").trim(),
    section: item.section === "foreign" ? "foreign" : "mexico",
    chargeKind: item.chargeKind === "contingent" ? "contingent" : "fixed",
    included: item.included !== false,
    unitPriceMax: item.unitPriceMax === "" || item.unitPriceMax === null || item.unitPriceMax === undefined ? null : Math.max(0, parseNumber(item.unitPriceMax, 0)),
    appliesTo: Array.isArray(item.appliesTo) ? item.appliesTo.map(String).filter((code) => ["FCL", "LCL", "BBK", "AIR"].includes(code)) : ["FCL", "LCL", "BBK", "AIR"],
    unitOfMeasure: String(item.unitOfMeasure || "").trim(),
    unit:
      item.unit === null || item.unit === "" || item.unit === undefined
        ? null
        : Math.max(0, parseNumber(item.unit, 1)),
    unitPrice: atCost ? "AT COST" : item.unitPrice == null || String(item.unitPrice).trim() === "" ? null : parseNumber(item.unitPrice, 0),
    currency,
    remark: String(item.remark || ""),
    isAtCost: atCost,
    source,
    calcRef,
  };
}

// P0 (20260617 batch3): kept in lockstep with server.js parseQuoteHeader so a
// quote round-tripped through a saved draft does NOT lose INLAND department, the
// transportMode, or extraFields. Cargo codes and display-label snapshots are
// historical values: removing or renaming a current option must not erase them.

function pickQuoteHeaderOption(value, options, fallback = "") {
  const normalized = String(value ?? "").trim().toUpperCase();
  return options.includes(normalized) ? normalized : fallback;
}

function normalizeQuoteHeader(header = {}) {
  const operation = String(header.operation || "").toUpperCase();
  const cargoType = normalizeQuoteCargoCode(header.cargoType);
  return {
    operation: operation === "EXPORT" ? "EXPORT" : "IMPORT",
    department: pickQuoteHeaderOption(
      header.department,
      QUOTE_DEPARTMENT_OPTIONS,
      DEFAULT_QUOTE_HEADER.department
    ),
    transportMode: pickQuoteHeaderOption(
      header.transportMode,
      QUOTE_TRANSPORT_MODE_OPTIONS,
      ""
    ),
    incoterm: pickQuoteHeaderOption(header.incoterm, QUOTE_INCOTERM_OPTIONS, ""),
    pol: String(header.pol ?? DEFAULT_QUOTE_HEADER.pol).trim(),
    pod: String(header.pod ?? DEFAULT_QUOTE_HEADER.pod).trim(),
    commodity: String(header.commodity || "").trim(),
    cargoType,
    importerQualification: ["own", "trading_company"].includes(header.importerQualification) ? header.importerQualification : "",
    specialImportQualification: ["yes", "no", "unknown"].includes(header.specialImportQualification) ? header.specialImportQualification : "",
    nomCertification: ["yes", "no", "unknown"].includes(header.nomCertification) ? header.nomCertification : "",
    ministryRegistration: ["yes", "no", "unknown"].includes(header.ministryRegistration) ? header.ministryRegistration : "",
    ...(header.cargoPricing ? { cargoPricing: normalizeCargoPricing(header.cargoPricing, cargoType) } : {}),
    ...(header.cargoPricingByType ? { cargoPricingByType: normalizeCargoPricingByType(header.cargoPricingByType) } : {}),
    showTotals: header.showTotals === true,
    notesSelectionExplicit: header.notesSelectionExplicit === true,
    outputAudience: header.outputAudience === "internal" ? "internal" : "customer",
    taxTreatment: ["included", "excluded"].includes(header.taxTreatment) ? header.taxTreatment : "unspecified",
    ...(cargoType && typeof header.cargoTypeLabel === "string" && header.cargoTypeLabel.trim()
      ? { cargoTypeLabel: header.cargoTypeLabel.trim().slice(0, 120) }
      : {}),
    delivery: String(header.delivery || "").trim(),
    extraFields: Array.isArray(header.extraFields)
      ? header.extraFields
          .map((f) => ({
            label: String(f.label || "").trim(),
            value: String(f.value || "").trim(),
          }))
          .filter((f) => f.label)
      : [],
  };
}

let quoteNoteSeq = 0;

function normalizeQuoteNote(note = {}, fallbackId) {
  const id =
    slugifyId(note.id, "") ||
    fallbackId ||
    `note-${(quoteNoteSeq += 1)}`;
  return {
    id,
    en: String(note.en || "").trim(),
    es: String(note.es || "").trim(),
    zh: String(note.zh || "").trim(),
  };
}

function normalizeQuoteDraft(draft = {}, fallbackId) {
  const id = slugifyId(draft.id, fallbackId);
  return {
    id,
    number: String(draft.number || "").trim(),
    date: String(draft.date || "").trim(),
    header: normalizeQuoteHeader(draft.header),
    // round11: quote mode (back-compat: old drafts have none -> mexico_only,
    // which == the legacy "MEXICO LOCAL only" behavior).
    quoteMode: normalizeQuoteMode(draft.quoteMode),
    lineItems: (Array.isArray(draft.lineItems) ? draft.lineItems : []).map(
      (item, index) => normalizeQuoteLineItem(item, `${id}-li-${index + 1}`)
    ),
    // S2/Q7: ordered remark selection + output language (back-compat: [] / "").
    noteIds: Array.isArray(draft.noteIds) ? draft.noteIds.map(String) : [],
    language: ["EN", "ZH", "ES"].includes(draft.language) ? draft.language : "",
    createdAt: draft.createdAt || null,
    updatedAt: draft.updatedAt || null,
  };
}

// S5: default header preset (each value validated against its option set; "" = none).

function normalizeQuoteHeaderDefaults(hd = {}, cargoTypes) {
  const pick = (value, options) => {
    const v = String(value ?? "").trim().toUpperCase();
    return options.includes(v) ? v : "";
  };
  const src = hd && typeof hd === "object" ? hd : {};
  return {
    department: pick(src.department, QUOTE_DEPARTMENT_OPTIONS),
    transportMode: pick(src.transportMode, QUOTE_TRANSPORT_MODE_OPTIONS),
    incoterm: pick(src.incoterm, QUOTE_INCOTERM_OPTIONS),
    cargoType: pick(
      normalizeQuoteCargoCode(src.cargoType),
      normalizeQuoteCargoTypes(cargoTypes).filter((entry) => entry.enabled).map((entry) => entry.code)
    ),
    // S5/round11: default quote mode for fresh quotes (mexico_only default).
    quoteMode: normalizeQuoteMode(src.quoteMode),
  };
}

function normalizeQuoteModuleData(moduleData = {}) {
  const settingsIn = moduleData.settings || {};
  let cargoTypes = normalizeQuoteCargoTypes(settingsIn.cargoTypes);
  if (Number(settingsIn.cargoTypePolicyVersion || 0) < 1) cargoTypes = cargoTypes.filter((entry) => ["FCL", "LCL", "BBK", "AIR"].includes(entry.code));
  // Add the newly requested AIR workflow once. An explicit empty list or an
  // existing disabled AIR remains an administrator's deliberate choice.
  if (Number(settingsIn.cargoTypePolicyVersion || 0) < 2 && cargoTypes.length && !cargoTypes.some((entry) => entry.code === "AIR")) {
    cargoTypes.push({ code: "AIR", label: "AIR", enabled: true });
  }
  const feeTemplates = normalizeQuoteFeeTemplates(Array.isArray(settingsIn.feeTemplates)
    ? settingsIn.feeTemplates
    : [...QUOTE_TEMPLATE_ROWS.filter((row) => row.section === "foreign").map((row, index) => ({...row, id: `foreign-${index + 1}`, chargeKind: "fixed", enabled: true, appliesTo: ["FCL", "LCL", "BBK"]})), ...DEFAULT_QUOTE_FEE_TEMPLATES]);
  if (Number(settingsIn.feeTemplateConfigVersion || 0) < 2) {
    const local = feeTemplates.find((row) => row.id === "delivery-order" && row.category === "SHIPPING LINE" && row.conceptEn === "Delivery Order Fee" && row.conceptZh === "船公司 LOCAL");
    if (local) local.conceptEn = "Shipping line local charge";
  }
  const defaultCurrencyByCategory = Object.fromEntries(Object.entries(DEFAULT_CURRENCY_BY_CATEGORY).map(([category, fallback]) => [category, ["MXN", "USD"].includes(settingsIn.defaultCurrencyByCategory?.[category]) ? settingsIn.defaultCurrencyByCategory[category] : fallback]));
  const templateVersion = parseNumber(settingsIn.templateVersion, 0);
  const seedTemplate =
    templateVersion < QUOTE_TEMPLATE_VERSION ||
    !Array.isArray(moduleData.templateRows) ||
    !moduleData.templateRows.length;
  const seedNotes = !Array.isArray(moduleData.notes) || !moduleData.notes.length;
  const notes = (seedNotes ? QUOTE_NOTES : moduleData.notes).map((note, index) => normalizeQuoteNote(note, `note-${index + 1}`));
  if (Number(settingsIn.taxDisclaimerPolicyVersion || 0) < 1) {
    // Only replace the exact provisional system wording tied to the removed
    // dual-currency tax block. Business-authored terms remain untouched.
    for (const note of notes) {
      if (note.en === "Prices are shown in two currencies: the MXN price is exclusive of VAT; the USD price already includes 16% VAT. Any exchange-rate difference is settled at the invoicing-date FX." && note.zh === "本报价以两种币种显示：比索（MXN）价为不含税价；美金（USD）价已含 16% 增值税（VAT）。汇率差异按开票当日汇率结算。") {
        note.en = QUOTE_NOTES[0].en;
        note.zh = QUOTE_NOTES[0].zh;
      }
    }
  }
  const pad = Math.min(
    8,
    Math.max(1, Math.trunc(parseNumber(settingsIn.quoteNumberPad, 3)) || 3)
  );

  return {
    settings: {
      defaultQuoteCurrency: normalizeCurrencyCode(
        settingsIn.defaultQuoteCurrency,
        "MXN"
      ),
      quoteNumberPrefix:
        typeof settingsIn.quoteNumberPrefix === "string"
          ? settingsIn.quoteNumberPrefix
          : "ELCMEX-SI-",
      quoteNumberSuffix:
        typeof settingsIn.quoteNumberSuffix === "string"
          ? settingsIn.quoteNumberSuffix
          : "E",
      quoteNumberPad: pad,
      lastQuoteSeq: Math.max(0, Math.trunc(parseNumber(settingsIn.lastQuoteSeq, 4))),
      showIndicativeConversion: Boolean(settingsIn.showIndicativeConversion),
      indicativeCurrency: normalizeCurrencyCode(settingsIn.indicativeCurrency, "MXN"),
      cargoTypes,
      cargoTypePolicyVersion: 2,
      taxDisclaimerPolicyVersion: 1,
      cargoPricingRules: normalizeCargoPricingRules(settingsIn.cargoPricingRules),
      feeTemplates,
      feeTemplateConfigVersion: QUOTE_CONFIG_VERSION,
      defaultCurrencyByCategory,
      // Only enabled cargo types can remain the default for a new quote.
      headerDefaults: normalizeQuoteHeaderDefaults(settingsIn.headerDefaults, cargoTypes),
      templateVersion: QUOTE_TEMPLATE_VERSION,
    },
    templateRows: (seedTemplate ? QUOTE_TEMPLATE_ROWS : moduleData.templateRows).map(
      (row, index) => normalizeQuoteLineItem(row, `tpl-${index + 1}`)
    ),
    notes,
    drafts: (Array.isArray(moduleData.drafts) ? moduleData.drafts : []).map(
      (draft, index) => normalizeQuoteDraft(draft, `q-${index + 1}`)
    ),
  };
}

module.exports = {
  normalizeQuoteLineItem,
  pickQuoteHeaderOption,
  normalizeQuoteHeader,
  normalizeQuoteNote,
  normalizeQuoteDraft,
  normalizeQuoteHeaderDefaults,
  normalizeQuoteModuleData,
};
