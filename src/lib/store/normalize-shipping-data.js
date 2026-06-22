// store/normalize-shipping-data: top-level normalizer that composes the per-module
// normalizers into a full shipping-data document. Imports ./shared + the 4 modules.

const {
  BUSINESS_MODULES,
  DEFAULT_MODULE_KEY,
} = require("../modules");
const {
  DEFAULT_PRICE_MODE,
  DEFAULT_QUOTE_CURRENCY,
  DEFAULT_TAX_RATE_PRESETS,
  normalizeCurrencyCode,
  normalizePriceMode,
} = require("../options");
const {
  normalizeExchangeRates,
  normalizeTaxRatePresets,
} = require("./shared");
const {
  normalizeHandoverModuleData,
} = require("./normalize-handover");
const {
  normalizeCustomsModuleData,
} = require("./normalize-customs");
const {
  normalizeInlandModuleData,
} = require("./normalize-inland");
const {
  normalizeQuoteModuleData,
} = require("./normalize-quote");

function createDefaultModuleData() {
  return {
    settings: {
      defaultQuoteCurrency: DEFAULT_QUOTE_CURRENCY,
      defaultPriceMode: DEFAULT_PRICE_MODE,
    },
    taxRatePresets: DEFAULT_TAX_RATE_PRESETS.map((preset) => ({ ...preset })),
    shippingLines: [],
    containerTypes: [],
  };
}

function normalizeGenericModuleData(moduleData = {}) {
  return {
    settings: {
      defaultQuoteCurrency: normalizeCurrencyCode(
        moduleData.settings?.defaultQuoteCurrency,
        DEFAULT_QUOTE_CURRENCY
      ),
      defaultPriceMode: normalizePriceMode(moduleData.settings?.defaultPriceMode),
    },
    taxRatePresets: normalizeTaxRatePresets(moduleData.taxRatePresets),
    shippingLines: [],
    containerTypes: [],
  };
}

function normalizeModules(data) {
  const legacyModule = {
    settings: data.settings || {},
    taxRatePresets: data.taxRatePresets || [],
    shippingLines: data.shippingLines || [],
  };
  const sourceModules =
    data.modules && typeof data.modules === "object"
      ? data.modules
      : { [DEFAULT_MODULE_KEY]: legacyModule };

  const normalizedModules = {
    handover: normalizeHandoverModuleData(
      sourceModules.handover || createDefaultModuleData()
    ),
  };

  normalizedModules.customs = normalizeCustomsModuleData(
    sourceModules.customs || createDefaultModuleData(),
    normalizedModules.handover
  );

  normalizedModules.inland = normalizeInlandModuleData(
    sourceModules.inland || {}
  );

  normalizedModules.quote = normalizeQuoteModuleData(sourceModules.quote || {});

  for (const module of BUSINESS_MODULES) {
    if (!normalizedModules[module.key]) {
      normalizedModules[module.key] = normalizeGenericModuleData(
        sourceModules[module.key] || createDefaultModuleData()
      );
    }
  }
  return normalizedModules;
}

function normalizeShippingData(data) {
  return {
    generatedFrom: data.generatedFrom || null,
    exchangeRates: normalizeExchangeRates(data.exchangeRates),
    modules: normalizeModules(data),
  };
}

module.exports = {
  createDefaultModuleData,
  normalizeGenericModuleData,
  normalizeModules,
  normalizeShippingData,
};
