// store/normalize-quote: quote module normalizer (settings / header defaults /
// drafts / line items / notes). Imports ./shared only.

const {
  normalizeCurrencyCode,
} = require("../options");
const {
  DEFAULT_QUOTE_HEADER,
  QUOTE_CARGO_TYPE_OPTIONS,
  QUOTE_DEPARTMENT_OPTIONS,
  QUOTE_GROUP_ORDER,
  QUOTE_INCOTERM_OPTIONS,
  QUOTE_NOTES,
  QUOTE_TEMPLATE_ROWS,
  QUOTE_TEMPLATE_VERSION,
  QUOTE_TRANSPORT_MODE_OPTIONS,
  normalizeQuoteMode,
} = require("../quote");
const {
  parseNumber,
  slugifyId,
} = require("./shared");

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
    unitOfMeasure: String(item.unitOfMeasure || "").trim(),
    unit:
      item.unit === null || item.unit === "" || item.unit === undefined
        ? null
        : Math.max(0, parseNumber(item.unit, 1)),
    unitPrice: atCost ? "AT COST" : parseNumber(item.unitPrice, 0),
    currency,
    remark: String(item.remark || ""),
    isAtCost: atCost,
    source,
    calcRef,
  };
}

// P0 (20260617 batch3): kept in lockstep with server.js parseQuoteHeader so a
// quote round-tripped through a saved draft does NOT lose INLAND department, the
// new cargo types, transportMode, or extraFields. Values outside the option sets
// are dropped (same as parseQuoteHeader) — Jose supplied the standard sets.

function pickQuoteHeaderOption(value, options, fallback = "") {
  const normalized = String(value ?? "").trim().toUpperCase();
  return options.includes(normalized) ? normalized : fallback;
}

function normalizeQuoteHeader(header = {}) {
  const operation = String(header.operation || "").toUpperCase();
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
    cargoType: pickQuoteHeaderOption(header.cargoType, QUOTE_CARGO_TYPE_OPTIONS, ""),
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

function normalizeQuoteHeaderDefaults(hd = {}) {
  const pick = (value, options) => {
    const v = String(value ?? "").trim().toUpperCase();
    return options.includes(v) ? v : "";
  };
  const src = hd && typeof hd === "object" ? hd : {};
  return {
    department: pick(src.department, QUOTE_DEPARTMENT_OPTIONS),
    transportMode: pick(src.transportMode, QUOTE_TRANSPORT_MODE_OPTIONS),
    incoterm: pick(src.incoterm, QUOTE_INCOTERM_OPTIONS),
    cargoType: pick(src.cargoType, QUOTE_CARGO_TYPE_OPTIONS),
    // S5/round11: default quote mode for fresh quotes (mexico_only default).
    quoteMode: normalizeQuoteMode(src.quoteMode),
  };
}

function normalizeQuoteModuleData(moduleData = {}) {
  const settingsIn = moduleData.settings || {};
  const templateVersion = parseNumber(settingsIn.templateVersion, 0);
  const seedTemplate =
    templateVersion < QUOTE_TEMPLATE_VERSION ||
    !Array.isArray(moduleData.templateRows) ||
    !moduleData.templateRows.length;
  const seedNotes = !Array.isArray(moduleData.notes) || !moduleData.notes.length;
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
      // S5 (batch3): default header values pre-filled on a new quote. Validated
      // against the same option sets; empty = no preset.
      headerDefaults: normalizeQuoteHeaderDefaults(settingsIn.headerDefaults),
      templateVersion: QUOTE_TEMPLATE_VERSION,
    },
    templateRows: (seedTemplate ? QUOTE_TEMPLATE_ROWS : moduleData.templateRows).map(
      (row, index) => normalizeQuoteLineItem(row, `tpl-${index + 1}`)
    ),
    notes: (seedNotes ? QUOTE_NOTES : moduleData.notes).map((note, index) =>
      normalizeQuoteNote(note, `note-${index + 1}`)
    ),
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
