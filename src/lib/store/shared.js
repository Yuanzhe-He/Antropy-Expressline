// store/shared: cross-cutting normalization primitives + rate-group consts used
// by every per-module normalizer. Leaf module (imports no store siblings).

const {
  DEFAULT_QUOTE_CURRENCY,
  DEFAULT_TAX_RATE_PRESETS,
  normalizeCurrencyCode,
  normalizeTaxRate,
} = require("../options");

const CUSTOMS_STORAGE_TIER_POLICY_VERSION = 2;
// Bumped when customs container types were unified with the handover module.
// Triggers a one-time rebuild of storage rule sets onto the new taxonomy.

const CUSTOMS_CONTAINER_TAXONOMY_VERSION = 1;

const RATE_GROUPS = Object.freeze({
  dry: ["gp-hq-dc", "gp-hc-sd", "gp-hq-dc-20-40", "imo-dry"],
  fortyFiveDry: [
    "special-45",
    "imo-special-45",
    "gp-hq-dc",
    "gp-hc-sd",
    "gp-hq-dc-20-40",
    "imo-dry",
  ],
  flatrack20: ["fr-20", "ot-fr-rf", "ot-fl-pl"],
  flatrack40: ["fr-40", "ot-fr-rf", "ot-fl-pl"],
  openTop20: ["ot-20", "ot-fr-rf", "ot-fl-pl"],
  openTop40: ["ot-40", "ot-fr-rf", "ot-fl-pl"],
  reefer20: ["rf-20", "reefer", "rf-rq", "ot-fr-rf", "imo-reefer"],
  reefer40: ["rf-40", "reefer", "rf-rq", "ot-fr-rf", "imo-reefer"],
  tank: ["ot-fr-rf", "ot-fl-pl"],
  platform20: ["ot-fl-pl", "ot-fr-rf", "fr-20"],
  platform40: ["ot-fl-pl", "ot-fr-rf", "fr-40"],
  fortyFiveOpenTop: ["special-45", "imo-special-45", "ot-40", "ot-fr-rf", "ot-fl-pl"],
});

// Editable display container-type master. Bumped to (re)seed the persisted
// master from STANDARD_HANDOVER_CONTAINER_TYPES on first load.

const CONTAINER_TYPE_MASTER_VERSION = 1;
// Reverse lookup: a container type's rateGroupKeys array → its named rate group.

const RATE_GROUP_NAME_BY_SIGNATURE = new Map(
  Object.entries(RATE_GROUPS).map(([name, keys]) => [keys.join("|"), name])
);

const RATE_GROUP_NAMES = Object.freeze(Object.keys(RATE_GROUPS));

const STANDARD_HANDOVER_CONTAINER_TYPES = Object.freeze([
  {
    key: "40GP",
    label: "40GP - Forty foot general purpose",
    code: "40GP",
    description: "Forty foot general purpose",
    mode: "SEA",
    containerType: "DRY",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.dry,
  },
  {
    key: "20FR",
    label: "20FR - Twenty foot flatrack",
    code: "20FR",
    description: "Twenty foot flatrack",
    mode: "SEA",
    containerType: "FLT",
    teu: 1,
    rateGroupKeys: RATE_GROUPS.flatrack20,
  },
  {
    key: "20GP",
    label: "20GP - Twenty foot general purpose",
    code: "20GP",
    description: "Twenty foot general purpose",
    mode: "SEA",
    containerType: "DRY",
    teu: 1,
    rateGroupKeys: RATE_GROUPS.dry,
  },
  {
    key: "20NOR",
    label: "20NOR - Twenty foot non-operating reefer",
    code: "20NOR",
    description: "Twenty foot non-operating reefer",
    mode: "SEA",
    containerType: "DRY",
    teu: 1,
    rateGroupKeys: RATE_GROUPS.dry,
  },
  {
    key: "20OT",
    label: "20OT - Twenty foot open top",
    code: "20OT",
    description: "Twenty foot open top",
    mode: "SEA",
    containerType: "TOP",
    teu: 1,
    rateGroupKeys: RATE_GROUPS.openTop20,
  },
  {
    key: "20PL",
    label: "20PL - Twenty foot platform",
    code: "20PL",
    description: "Twenty foot platform",
    mode: "SEA",
    containerType: "DRY",
    teu: 1,
    rateGroupKeys: RATE_GROUPS.platform20,
  },
  {
    key: "40FR",
    label: "40FR - Forty foot flatrack",
    code: "40FR",
    description: "Forty foot flatrack",
    mode: "SEA",
    containerType: "FLT",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.flatrack40,
  },
  {
    key: "40NOR",
    label: "40NOR - Forty foot non-operating reefer",
    code: "40NOR",
    description: "Forty foot non-operating reefer",
    mode: "SEA",
    containerType: "DRY",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.dry,
  },
  {
    key: "40OT",
    label: "40OT - Forty foot open top",
    code: "40OT",
    description: "Forty foot open top",
    mode: "SEA",
    containerType: "TOP",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.openTop40,
  },
  {
    key: "40PL",
    label: "40PL - Forty foot platform",
    code: "40PL",
    description: "Forty foot platform",
    mode: "SEA",
    containerType: "DRY",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.platform40,
  },
  {
    key: "20HC",
    label: "20HC - Twenty foot high cube",
    code: "20HC",
    description: "Twenty foot high cube",
    mode: "SEA",
    containerType: "DRY",
    teu: 1,
    rateGroupKeys: RATE_GROUPS.dry,
  },
  {
    key: "20RHC",
    label: "20RHC - Twenty Foot high cube Reefer",
    code: "20RHC",
    description: "Twenty Foot high cube Reefer",
    mode: "SEA",
    containerType: "RFG",
    teu: 1,
    rateGroupKeys: RATE_GROUPS.reefer20,
  },
  {
    key: "20RF",
    label: "20RF - Twenty foot reefer",
    code: "20RF",
    description: "Twenty foot reefer",
    mode: "SEA",
    containerType: "RFG",
    teu: 1,
    rateGroupKeys: RATE_GROUPS.reefer20,
  },
  {
    key: "20TK",
    label: "20TK - Twenty foot Tank trailer",
    code: "20TK",
    description: "Twenty foot Tank trailer",
    mode: "SEA",
    containerType: "TNK",
    teu: 1,
    rateGroupKeys: RATE_GROUPS.tank,
  },
  {
    key: "40HC",
    label: "40HC - Forty foot high cube",
    code: "40HC",
    description: "Forty foot high cube",
    mode: "SEA",
    containerType: "DRY",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.dry,
  },
  {
    key: "40RHC",
    label: "40RHC - Forty foot high cube reefer",
    code: "40RHC",
    description: "Forty foot high cube reefer",
    mode: "SEA",
    containerType: "RFG",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.reefer40,
  },
  {
    key: "40RF",
    label: "40RF - Forty foot reefer",
    code: "40RF",
    description: "Forty foot reefer",
    mode: "SEA",
    containerType: "RFG",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.reefer40,
  },
  {
    key: "40TK",
    label: "40TK - Forty foot Tank trailer",
    code: "40TK",
    description: "Forty foot Tank trailer",
    mode: "SEA",
    containerType: "TNK",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.tank,
  },
  {
    key: "45HC",
    label: "45HC - Forty Five foot high cube",
    code: "45HC",
    description: "Forty Five foot high cube",
    mode: "SEA",
    containerType: "DRY",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.fortyFiveDry,
  },
  {
    key: "45OT",
    label: "45OT - Forty five foot open top",
    code: "45OT",
    description: "Forty five foot open top",
    mode: "SEA",
    containerType: "TOP",
    teu: 2,
    rateGroupKeys: RATE_GROUPS.fortyFiveOpenTop,
  },
]);

function parseNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function inferTaxRateFromMultiplier(multiplier) {
  const numeric = Number(multiplier);
  if (!Number.isFinite(numeric) || numeric <= 1) {
    return 0;
  }
  return Math.max(0, Number((numeric - 1).toFixed(4)));
}

function parseDemurrageRange(label) {
  const normalized = String(label || "").trim();
  if (!normalized) {
    return { startDay: null, endDay: null };
  }

  const rangeMatch = normalized.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    return {
      startDay: Number(rangeMatch[1]),
      endDay: Number(rangeMatch[2]),
    };
  }

  const greaterMatch = normalized.match(/^>(\d+)$/);
  if (greaterMatch) {
    return {
      startDay: Number(greaterMatch[1]) + 1,
      endDay: null,
    };
  }

  const reverseGreaterMatch = normalized.match(/^(\d+)>$/);
  if (reverseGreaterMatch) {
    return {
      startDay: Number(reverseGreaterMatch[1]) + 1,
      endDay: null,
    };
  }

  const singleMatch = normalized.match(/^(\d+)$/);
  if (singleMatch) {
    return {
      startDay: Number(singleMatch[1]),
      endDay: Number(singleMatch[1]),
    };
  }

  return { startDay: null, endDay: null };
}

function formatDemurrageRuleLabel(startDay, endDay, freeRule = false) {
  if (startDay === null || startDay === undefined) {
    return "未设置";
  }
  if (endDay === null || endDay === undefined) {
    return `>${startDay - 1}`;
  }
  if (freeRule && startDay === 1) {
    return `0-${endDay}`;
  }
  if (startDay === endDay) {
    return `${startDay}`;
  }
  return `${startDay}-${endDay}`;
}

function normalizeRateConfig(rateConfig) {
  if (!rateConfig) {
    return null;
  }

  return {
    ...rateConfig,
    qtyHint: parseNumber(rateConfig.qtyHint, 1) || 1,
    currency: normalizeCurrencyCode(rateConfig.currency),
    rate: parseNumber(rateConfig.rate, 0),
  };
}

function normalizeGroupRates(groupRates = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(groupRates)) {
    const normalizedValue = normalizeRateConfig(value);
    if (normalizedValue) {
      normalized[key] = normalizedValue;
    }
  }
  return normalized;
}

function normalizeCharge(charge, fallbackId) {
  const groupRates = normalizeGroupRates(charge.groupRates);
  const blRate = normalizeRateConfig(charge.blRate);

  return {
    id: charge.id || fallbackId,
    concept: charge.concept || fallbackId,
    note: charge.note || null,
    taxRate: normalizeTaxRate(
      charge.taxRate,
      inferTaxRateFromMultiplier(charge.taxMultiplier)
    ),
    groupRates,
    blRate,
  };
}

function normalizeDemurrageTier(tier, fallbackId) {
  const range = parseDemurrageRange(tier.label);

  return {
    id: tier.id || fallbackId,
    label: tier.label || fallbackId,
    note: tier.note || null,
    startDay:
      tier.startDay === null || tier.startDay === undefined
        ? range.startDay
        : parseNumber(tier.startDay, range.startDay),
    endDay:
      tier.endDay === null || tier.endDay === undefined || tier.endDay === ""
        ? range.endDay
        : parseNumber(tier.endDay, range.endDay),
    taxRate: normalizeTaxRate(
      tier.taxRate,
      inferTaxRateFromMultiplier(tier.taxMultiplier)
    ),
    groupRates: normalizeGroupRates(tier.groupRates),
  };
}

function normalizeDemurrageRule(rule, fallbackId) {
  const range = parseDemurrageRange(rule.label);
  const startDay =
    rule.startDay === null || rule.startDay === undefined
      ? range.startDay
      : parseNumber(rule.startDay, range.startDay);
  const endDay =
    rule.endDay === null || rule.endDay === undefined || rule.endDay === ""
      ? range.endDay
      : parseNumber(rule.endDay, range.endDay);
  const rateConfig = normalizeRateConfig(rule.rateConfig);
  const freeRule = Boolean(rule.freeRule || rateConfig?.rate === 0);

  return {
    id: rule.id || fallbackId,
    label: rule.label || formatDemurrageRuleLabel(startDay, endDay, freeRule),
    note: rule.note || null,
    startDay,
    endDay,
    freeRule,
    taxRate: normalizeTaxRate(
      rule.taxRate,
      inferTaxRateFromMultiplier(rule.taxMultiplier)
    ),
    rateConfig: rateConfig || {
      qtyHint: 1,
      currency: DEFAULT_QUOTE_CURRENCY,
      rate: 0,
    },
  };
}

function slugifyId(value, fallback) {
  return (
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

function normalizeDemurrageRuleList(rules = [], prefix) {
  return (rules || [])
    .map((rule, index) =>
      normalizeDemurrageRule(rule, `${prefix}-rule-${index + 1}`)
    )
    .sort((left, right) => {
      if (left.startDay === null) {
        return 1;
      }
      if (right.startDay === null) {
        return -1;
      }
      return left.startDay - right.startDay;
    });
}

function isLegacyThreeTierStorageDefault(rules = []) {
  if (!Array.isArray(rules) || rules.length !== 3) {
    return false;
  }

  const [first, second, third] = rules;
  const firstRate = parseNumber(first.rateConfig?.rate, 0);
  return (
    first.startDay === 1 &&
    first.endDay === 7 &&
    firstRate === 0 &&
    second.startDay === 8 &&
    second.endDay === 10 &&
    third.startDay === 11 &&
    (third.endDay === null || third.endDay === undefined)
  );
}

function migrateLegacyStorageRulesToTwoTiers(rules = []) {
  if (!isLegacyThreeTierStorageDefault(rules)) {
    return rules;
  }

  const [freeRule, paidRule] = rules;
  const migratedPaidRule = {
    ...paidRule,
    endDay: null,
    label: formatDemurrageRuleLabel(paidRule.startDay, null, false),
  };
  return [freeRule, migratedPaidRule];
}

function normalizeTaxRatePresets(presets) {
  const source =
    Array.isArray(presets) && presets.length ? presets : DEFAULT_TAX_RATE_PRESETS;
  return source
    .map((preset, index) => ({
      id: preset.id || `tax-rate-${index + 1}`,
      label: preset.label || `${Math.round(parseNumber(preset.rate, 0) * 100)}%`,
      rate: normalizeTaxRate(preset.rate, 0),
    }))
    .filter((preset) => preset.label);
}

function normalizeExchangeRates(exchangeRates = {}) {
  const pairs = Array.isArray(exchangeRates.pairs)
    ? exchangeRates.pairs
        .map((pair) => ({
          base: normalizeCurrencyCode(pair.base, "USD"),
          quote: normalizeCurrencyCode(pair.quote, "MXN"),
          rate: parseNumber(pair.rate, 0),
        }))
        .filter((pair) => pair.rate > 0)
    : [];

  return {
    provider: exchangeRates.provider || "Frankfurter",
    docsUrl: exchangeRates.docsUrl || "https://frankfurter.dev/",
    asOfDate: exchangeRates.asOfDate || null,
    lastCheckedAt: exchangeRates.lastCheckedAt || null,
    lastError: exchangeRates.lastError || null,
    defaultQuoteCurrency: normalizeCurrencyCode(
      exchangeRates.defaultQuoteCurrency,
      DEFAULT_QUOTE_CURRENCY
    ),
    pairs,
  };
}

function normalizeIdList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  }
  return [];
}

function normalizeContainerTypeList(rawTypes = [], fallbackTypes = []) {
  const registry = new Map();
  for (const source of [...fallbackTypes, ...rawTypes]) {
    if (!source?.key) {
      continue;
    }
    registry.set(source.key, {
      key: source.key,
      label: source.label || source.key,
    });
  }
  return [...registry.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function ensureRatesForContainerTypes(groupRates = {}, containerTypes = []) {
  const normalized = normalizeGroupRates(groupRates);
  // Container types are the source of truth: keep a rate entry for each current
  // type (preserving existing values) and drop stale keys left over from a
  // previous container taxonomy.
  const result = {};
  for (const type of containerTypes) {
    result[type.key] = normalized[type.key] || {
      label: type.label,
      qtyHint: 1,
      currency: DEFAULT_QUOTE_CURRENCY,
      rate: 0,
    };
  }
  return result;
}

function parseNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  CUSTOMS_STORAGE_TIER_POLICY_VERSION,
  CUSTOMS_CONTAINER_TAXONOMY_VERSION,
  RATE_GROUPS,
  CONTAINER_TYPE_MASTER_VERSION,
  RATE_GROUP_NAME_BY_SIGNATURE,
  RATE_GROUP_NAMES,
  STANDARD_HANDOVER_CONTAINER_TYPES,
  parseNumber,
  inferTaxRateFromMultiplier,
  parseDemurrageRange,
  formatDemurrageRuleLabel,
  normalizeRateConfig,
  normalizeGroupRates,
  normalizeCharge,
  normalizeDemurrageTier,
  normalizeDemurrageRule,
  slugifyId,
  normalizeDemurrageRuleList,
  isLegacyThreeTierStorageDefault,
  migrateLegacyStorageRulesToTwoTiers,
  normalizeTaxRatePresets,
  normalizeExchangeRates,
  normalizeIdList,
  normalizeContainerTypeList,
  ensureRatesForContainerTypes,
  parseNullableNumber,
};
