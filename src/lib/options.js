const DEMURRAGE_CUTOFF_OPTIONS = Object.freeze([
  { value: "customs_broker_only", labelKey: "demurrageCutoff.customsBrokerOnly" },
  { value: "customer_only", labelKey: "demurrageCutoff.customerOnly" },
  { value: "broker_or_consignee", labelKey: "demurrageCutoff.brokerOrConsignee" },
]);

const PRICE_MODE_OPTIONS = Object.freeze([
  { value: "pretax", labelKey: "priceMode.pretax" },
  { value: "aftertax", labelKey: "priceMode.aftertax" },
]);

const BUSINESS_NATURE_OPTIONS = Object.freeze([
  { value: "handover_only", labelKey: "businessNature.handoverOnly" },
  { value: "customs_only", labelKey: "businessNature.customsOnly" },
  { value: "handover_customs", labelKey: "businessNature.handoverCustoms" },
]);

const CURRENCY_OPTIONS = Object.freeze([
  { code: "MXN", label: "MXN" },
  { code: "USD", label: "USD" },
]);

const DEFAULT_TAX_RATE_PRESETS = Object.freeze([
  { id: "vat-0", label: "0%", rate: 0 },
  { id: "vat-16", label: "16%", rate: 0.16 },
]);

const CATEGORY_LABEL_KEYS = Object.freeze({
  localCharges: "categories.localCharges",
  guarantee: "categories.guarantee",
  demurrage: "categories.demurrage",
});

const DEFAULT_DEMURRAGE_CUTOFF = DEMURRAGE_CUTOFF_OPTIONS[0].value;
const DEFAULT_PRICE_MODE = PRICE_MODE_OPTIONS[1].value;
const DEFAULT_QUOTE_CURRENCY = "MXN";
const DEFAULT_BUSINESS_NATURE = BUSINESS_NATURE_OPTIONS[0].value;

function getLocalizedOptions(options, t) {
  return options.map((option) => ({
    ...option,
    label: option.labelKey ? t(option.labelKey) : option.label,
  }));
}

function getDemurrageCutoffLabel(value, t = null) {
  const option =
    DEMURRAGE_CUTOFF_OPTIONS.find((entry) => entry.value === value) ||
    DEMURRAGE_CUTOFF_OPTIONS[0];
  return t ? t(option.labelKey) : option.labelKey;
}

function getCategoryLabel(key, t = null) {
  const labelKey = CATEGORY_LABEL_KEYS[key] || key;
  return t ? t(labelKey) : labelKey;
}

function normalizeTaxRate(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizePriceMode(value) {
  return PRICE_MODE_OPTIONS.some((option) => option.value === value)
    ? value
    : DEFAULT_PRICE_MODE;
}

function normalizeBusinessNature(value, fallback = DEFAULT_BUSINESS_NATURE) {
  return BUSINESS_NATURE_OPTIONS.some((option) => option.value === value)
    ? value
    : fallback;
}

function normalizeCurrencyCode(value, fallback = DEFAULT_QUOTE_CURRENCY) {
  const normalized = String(value || "").trim().toUpperCase();
  return CURRENCY_OPTIONS.some((option) => option.code === normalized)
    ? normalized
    : fallback;
}

function getTaxRateLabel(value) {
  return `${Math.round(normalizeTaxRate(value) * 100)}%`;
}

module.exports = {
  BUSINESS_NATURE_OPTIONS,
  CATEGORY_LABEL_KEYS,
  CURRENCY_OPTIONS,
  DEFAULT_BUSINESS_NATURE,
  DEFAULT_DEMURRAGE_CUTOFF,
  DEFAULT_PRICE_MODE,
  DEFAULT_QUOTE_CURRENCY,
  DEFAULT_TAX_RATE_PRESETS,
  DEMURRAGE_CUTOFF_OPTIONS,
  PRICE_MODE_OPTIONS,
  getCategoryLabel,
  getDemurrageCutoffLabel,
  getLocalizedOptions,
  getTaxRateLabel,
  normalizeBusinessNature,
  normalizeCurrencyCode,
  normalizePriceMode,
  normalizeTaxRate,
};
