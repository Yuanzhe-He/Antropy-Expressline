const fs = require("node:fs/promises");
const path = require("node:path");
const {
  DEFAULT_DEMURRAGE_CUTOFF,
  DEFAULT_PRICE_MODE,
  DEFAULT_QUOTE_CURRENCY,
  DEFAULT_TAX_RATE_PRESETS,
  DEMURRAGE_CUTOFF_OPTIONS,
  normalizeCurrencyCode,
  normalizePriceMode,
  normalizeTaxRate,
} = require("./options");
const { BUSINESS_MODULES, DEFAULT_MODULE_KEY } = require("./modules");

const bundledDataDir = path.join(__dirname, "../../data");
const dataDir = path.resolve(process.env.DATA_DIR || bundledDataDir);
const shippingLinesFile = path.join(dataDir, "shipping-lines.json");
const usersFile = path.join(dataDir, "users.json");
const seedShippingLinesFile = path.join(bundledDataDir, "shipping-lines.json");
const seedUsersFile = path.join(bundledDataDir, "users.json");

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

async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readSeededJson(filePath, seedFilePath, fallback) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (path.resolve(filePath) !== path.resolve(seedFilePath)) {
    try {
      const seedContent = await fs.readFile(seedFilePath, "utf8");
      const seedPayload = JSON.parse(seedContent);
      await writeJson(filePath, seedPayload);
      return seedPayload;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return fallback;
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

function normalizeGuarantee(guarantee = {}) {
  return {
    benefitEnabled: Boolean(guarantee.benefitEnabled),
    benefitExpiresAt: guarantee.benefitExpiresAt || null,
    benefitNote: guarantee.benefitNote || null,
    taxRate: normalizeTaxRate(
      guarantee.taxRate,
      inferTaxRateFromMultiplier(guarantee.taxMultiplier)
    ),
    ratesByGroup: normalizeGroupRates(guarantee.ratesByGroup),
    fallbackRatesByGroup: normalizeGroupRates(guarantee.fallbackRatesByGroup),
    blRate: normalizeRateConfig(guarantee.blRate),
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

function buildLegacyDemurrageRulesByGroup(shippingLine, containerGroups) {
  const rulesByGroup = {};
  for (const group of containerGroups) {
    const groupRules = [];
    const freeDays =
      parseNumber(shippingLine.demurrage?.freeDays?.daysByGroup?.[group.key], NaN) ||
      parseNumber(shippingLine.demurrage?.freeDays?.defaultDays, 0);

    if (freeDays > 0) {
      groupRules.push(
        normalizeDemurrageRule(
          {
            id: `${shippingLine.id}-${group.key}-free`,
            label: formatDemurrageRuleLabel(1, freeDays, true),
            startDay: 1,
            endDay: freeDays,
            freeRule: true,
            taxRate: 0,
            rateConfig: {
              label: group.label,
              qtyHint: 1,
              currency: DEFAULT_QUOTE_CURRENCY,
              rate: 0,
            },
          },
          `${shippingLine.id}-${group.key}-free`
        )
      );
    }

    for (const tier of shippingLine.demurrage?.tiers || []) {
      const normalizedTier = normalizeDemurrageTier(tier, tier.id);
      const rateConfig = normalizedTier.groupRates?.[group.key];
      if (!rateConfig) {
        continue;
      }
      groupRules.push(
        normalizeDemurrageRule(
          {
            id: `${normalizedTier.id}-${group.key}`,
            label: normalizedTier.label,
            note: normalizedTier.note,
            startDay: normalizedTier.startDay,
            endDay: normalizedTier.endDay,
            freeRule: Number(rateConfig.rate) === 0,
            taxRate: normalizedTier.taxRate,
            rateConfig,
          },
          `${normalizedTier.id}-${group.key}`
        )
      );
    }

    rulesByGroup[group.key] = groupRules.sort((left, right) => {
      if (left.startDay === null) {
        return 1;
      }
      if (right.startDay === null) {
        return -1;
      }
      return left.startDay - right.startDay;
    });
  }
  return rulesByGroup;
}

function normalizeDemurrageRulesByGroup(shippingLine, containerGroups) {
  if (
    shippingLine.demurrage?.rulesByGroup &&
    Object.keys(shippingLine.demurrage.rulesByGroup).length
  ) {
    const normalized = {};
    for (const group of containerGroups) {
      const groupRules = shippingLine.demurrage.rulesByGroup[group.key] || [];
      normalized[group.key] = groupRules
        .map((rule, index) =>
          normalizeDemurrageRule(
            rule,
            `${shippingLine.id || "line"}-${group.key}-rule-${index + 1}`
          )
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
    return normalized;
  }

  return buildLegacyDemurrageRulesByGroup(shippingLine, containerGroups);
}

function normalizeShippingLine(shippingLine) {
  const cutoffValid = DEMURRAGE_CUTOFF_OPTIONS.some(
    (option) => option.value === shippingLine.demurrageCutoffHandledBy
  );
  const containerGroups = (shippingLine.containerGroups || []).map((group) => ({
    key: group.key,
    label: group.label,
  }));
  const localCharges = (shippingLine.localCharges || []).map((charge, index) =>
    normalizeCharge(charge, `${shippingLine.id || "line"}-charge-${index + 1}`)
  );
  const rulesByGroup = normalizeDemurrageRulesByGroup(shippingLine, containerGroups);

  return {
    ...shippingLine,
    invoiceToConsigneeOnly: Boolean(shippingLine.invoiceToConsigneeOnly),
    demurrageCutoffHandledBy: cutoffValid
      ? shippingLine.demurrageCutoffHandledBy
      : DEFAULT_DEMURRAGE_CUTOFF,
    containerGroups,
    localCharges,
    guarantee: normalizeGuarantee(shippingLine.guarantee),
    demurrage: {
      calculationMode: "progressive",
      freeDays: {
        defaultDays: parseNumber(shippingLine.demurrage?.freeDays?.defaultDays, 0),
        daysByGroup: shippingLine.demurrage?.freeDays?.daysByGroup || {},
      },
      rulesByGroup,
    },
    quoteDefaults: {
      priceMode: normalizePriceMode(shippingLine.quoteDefaults?.priceMode),
      quoteCurrency: normalizeCurrencyCode(
        shippingLine.quoteDefaults?.quoteCurrency,
        DEFAULT_QUOTE_CURRENCY
      ),
    },
  };
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
    docsUrl: exchangeRates.docsUrl || "https://frankfurter.dev/v1/",
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

function deriveContainerTypes(shippingLines) {
  const registry = new Map();

  for (const shippingLine of shippingLines) {
    for (const group of shippingLine.containerGroups || []) {
      if (!registry.has(group.key)) {
        registry.set(group.key, {
          key: group.key,
          label: group.label,
          shippingLines: new Set(),
        });
      }
      registry.get(group.key).shippingLines.add(shippingLine.name);
    }
  }

  return [...registry.values()]
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      shippingLineCount: entry.shippingLines.size,
      shippingLines: [...entry.shippingLines].sort(),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
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

function normalizeSimpleShippingLine(entry, fallbackId) {
  return {
    id: entry.id || fallbackId,
    name: entry.name || fallbackId,
    active: entry.active !== false,
    notes: entry.notes || null,
    yardIds: normalizeIdList(entry.yardIds),
  };
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
  for (const type of containerTypes) {
    if (!normalized[type.key]) {
      normalized[type.key] = {
        label: type.label,
        qtyHint: 1,
        currency: DEFAULT_QUOTE_CURRENCY,
        rate: 0,
      };
    }
  }
  return normalized;
}

function normalizeCustomsCharge(charge, fallbackId, containerTypes) {
  return {
    id: charge.id || fallbackId,
    concept: charge.concept || fallbackId,
    note: charge.note || null,
    taxRate: normalizeTaxRate(
      charge.taxRate,
      inferTaxRateFromMultiplier(charge.taxMultiplier)
    ),
    groupRates: ensureRatesForContainerTypes(charge.groupRates, containerTypes),
  };
}

function buildDefaultProgressiveRules(containerType, prefix) {
  return [
    normalizeDemurrageRule(
      {
        id: `${prefix}-${containerType.key}-free`,
        startDay: 1,
        endDay: 7,
        freeRule: true,
        taxRate: 0,
        rateConfig: {
          label: containerType.label,
          qtyHint: 1,
          currency: DEFAULT_QUOTE_CURRENCY,
          rate: 0,
        },
      },
      `${prefix}-${containerType.key}-free`
    ),
    normalizeDemurrageRule(
      {
        id: `${prefix}-${containerType.key}-slab-2`,
        startDay: 8,
        endDay: 10,
        freeRule: false,
        taxRate: 0,
        rateConfig: {
          label: containerType.label,
          qtyHint: 1,
          currency: DEFAULT_QUOTE_CURRENCY,
          rate: 0,
        },
      },
      `${prefix}-${containerType.key}-slab-2`
    ),
    normalizeDemurrageRule(
      {
        id: `${prefix}-${containerType.key}-slab-3`,
        startDay: 11,
        endDay: null,
        freeRule: false,
        taxRate: 0,
        rateConfig: {
          label: containerType.label,
          qtyHint: 1,
          currency: DEFAULT_QUOTE_CURRENCY,
          rate: 0,
        },
      },
      `${prefix}-${containerType.key}-slab-3`
    ),
  ];
}

function normalizeStorageRulesByContainer(storageRulesByContainer = {}, containerTypes = [], prefix) {
  const normalized = {};
  for (const type of containerTypes) {
    const sourceRules = storageRulesByContainer[type.key];
    const normalizedRules = (Array.isArray(sourceRules) && sourceRules.length
      ? sourceRules
      : buildDefaultProgressiveRules(type, prefix)
    )
      .map((rule, index) =>
        normalizeDemurrageRule(
          rule,
          `${prefix}-${type.key}-rule-${index + 1}`
        )
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

    normalized[type.key] = normalizedRules;
  }
  return normalized;
}

function normalizeCustomsTerminal(terminal, containerTypes, fallbackId) {
  return {
    id: terminal.id || fallbackId,
    name: terminal.name || fallbackId,
    note: terminal.note || null,
    fixedCharges: (terminal.fixedCharges || []).map((charge, index) =>
      normalizeCustomsCharge(
        charge,
        `${terminal.id || fallbackId}-fixed-${index + 1}`,
        containerTypes
      )
    ),
    storageRulesByContainer: normalizeStorageRulesByContainer(
      terminal.storageRulesByContainer,
      containerTypes,
      `${terminal.id || fallbackId}-storage`
    ),
  };
}

function normalizeCustomsPort(port, containerTypes, fallbackId) {
  return {
    id: port.id || fallbackId,
    name: port.name || fallbackId,
    note: port.note || null,
    terminals: (port.terminals || []).map((terminal, index) =>
      normalizeCustomsTerminal(
        terminal,
        containerTypes,
        `${port.id || fallbackId}-terminal-${index + 1}`
      )
    ),
  };
}

function normalizeCustomsYard(yard, containerTypes, fallbackId) {
  return {
    id: yard.id || fallbackId,
    name: yard.name || fallbackId,
    note: yard.note || null,
    portIds: normalizeIdList(yard.portIds),
    shippingLineIds: normalizeIdList(yard.shippingLineIds),
    dropoffCharges: (yard.dropoffCharges || []).map((charge, index) =>
      normalizeCustomsCharge(
        charge,
        `${yard.id || fallbackId}-dropoff-${index + 1}`,
        containerTypes
      )
    ),
    customsCharges: (yard.customsCharges || []).map((charge, index) =>
      normalizeCustomsCharge(
        charge,
        `${yard.id || fallbackId}-customs-${index + 1}`,
        containerTypes
      )
    ),
  };
}

function buildSampleRatesByType(containerTypes, baseRate, increment = 120, currency = "MXN") {
  const rates = {};
  for (const [index, type] of containerTypes.entries()) {
    rates[type.key] = {
      label: type.label,
      qtyHint: 1,
      currency,
      rate: baseRate + index * increment,
    };
  }
  return rates;
}

function createDefaultCustomsSeedData(handoverModule) {
  const fallbackContainerTypes =
    handoverModule.containerTypes?.length
      ? handoverModule.containerTypes.map((type) => ({
          key: type.key,
          label: type.label,
        }))
      : [
          { key: "20gp", label: "20GP" },
          { key: "40gp", label: "40GP" },
          { key: "40hq", label: "40HQ" },
        ];

  const fallbackShippingLines =
    handoverModule.shippingLines?.length
      ? handoverModule.shippingLines.map((line) => ({
          id: line.id,
          name: line.name,
          active: true,
        }))
      : [
          { id: "cma-cgm", name: "CMA CGM", active: true },
          { id: "hapag-lloyd", name: "Hapag-Lloyd", active: true },
          { id: "maersk", name: "Maersk", active: true },
        ];

  const sampleLineIds = fallbackShippingLines.slice(0, 4).map((line) => line.id);

  return {
    settings: {
      defaultQuoteCurrency: DEFAULT_QUOTE_CURRENCY,
      defaultPriceMode: DEFAULT_PRICE_MODE,
    },
    taxRatePresets: DEFAULT_TAX_RATE_PRESETS.map((preset) => ({ ...preset })),
    shippingLines: fallbackShippingLines,
    containerTypes: fallbackContainerTypes,
    ports: [
      {
        id: "manzanillo",
        name: "Manzanillo",
        note: "清关与码头费按港口下的不同码头分别维护。",
        terminals: [
          {
            id: "contecon-manzanillo",
            name: "Contecon Manzanillo",
            fixedCharges: [
              {
                id: "contecon-fixed",
                concept: "Terminal fijo por contenedor",
                note: "固定费用按柜计。",
                taxRate: 0.16,
                groupRates: buildSampleRatesByType(fallbackContainerTypes, 420, 140, "MXN"),
              },
            ],
            storageRulesByContainer: Object.fromEntries(
              fallbackContainerTypes.map((type, index) => [
                type.key,
                [
                  {
                    id: `contecon-${type.key}-free`,
                    startDay: 1,
                    endDay: 7,
                    freeRule: true,
                    taxRate: 0,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 0,
                    },
                  },
                  {
                    id: `contecon-${type.key}-tier-2`,
                    startDay: 8,
                    endDay: 10,
                    taxRate: 0.16,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 115 + index * 25,
                    },
                  },
                  {
                    id: `contecon-${type.key}-tier-3`,
                    startDay: 11,
                    endDay: null,
                    taxRate: 0.16,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 200 + index * 40,
                    },
                  },
                ],
              ])
            ),
          },
          {
            id: "ssa-manzanillo",
            name: "SSA Manzanillo",
            fixedCharges: [
              {
                id: "ssa-fixed",
                concept: "Terminal fijo por contenedor",
                note: "示例数据，可在后台按码头改成真实费率。",
                taxRate: 0.16,
                groupRates: buildSampleRatesByType(fallbackContainerTypes, 390, 135, "MXN"),
              },
            ],
            storageRulesByContainer: Object.fromEntries(
              fallbackContainerTypes.map((type, index) => [
                type.key,
                [
                  {
                    id: `ssa-${type.key}-free`,
                    startDay: 1,
                    endDay: 5,
                    freeRule: true,
                    taxRate: 0,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 0,
                    },
                  },
                  {
                    id: `ssa-${type.key}-tier-2`,
                    startDay: 6,
                    endDay: 9,
                    taxRate: 0.16,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 130 + index * 20,
                    },
                  },
                  {
                    id: `ssa-${type.key}-tier-3`,
                    startDay: 10,
                    endDay: null,
                    taxRate: 0.16,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 220 + index * 35,
                    },
                  },
                ],
              ])
            ),
          },
        ],
      },
      {
        id: "lazaro-cardenas",
        name: "Lazaro Cardenas",
        note: "第二个港口示例，便于演示不同港口多个码头。",
        terminals: [
          {
            id: "hutchison-lc",
            name: "Hutchison Ports LCT",
            fixedCharges: [
              {
                id: "hutchison-fixed",
                concept: "Terminal fijo por contenedor",
                taxRate: 0.16,
                groupRates: buildSampleRatesByType(fallbackContainerTypes, 460, 150, "MXN"),
              },
            ],
            storageRulesByContainer: Object.fromEntries(
              fallbackContainerTypes.map((type, index) => [
                type.key,
                [
                  {
                    id: `hutchison-${type.key}-free`,
                    startDay: 1,
                    endDay: 7,
                    freeRule: true,
                    taxRate: 0,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 0,
                    },
                  },
                  {
                    id: `hutchison-${type.key}-tier-2`,
                    startDay: 8,
                    endDay: 10,
                    taxRate: 0.16,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 120 + index * 25,
                    },
                  },
                  {
                    id: `hutchison-${type.key}-tier-3`,
                    startDay: 11,
                    endDay: null,
                    taxRate: 0.16,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 210 + index * 45,
                    },
                  },
                ],
              ])
            ),
          },
        ],
      },
    ],
    yards: [
      {
        id: "yard-mzo-norte",
        name: "Patio Aduanal Norte",
        note: "落柜与清关同页计算，可按港口和船公司自动筛出。",
        portIds: ["manzanillo"],
        shippingLineIds: sampleLineIds.slice(0, 2),
        dropoffCharges: [
          {
            id: "yard-mzo-norte-dropoff",
            concept: "落柜",
            taxRate: 0.16,
            groupRates: buildSampleRatesByType(fallbackContainerTypes, 580, 160, "MXN"),
          },
        ],
        customsCharges: [
          {
            id: "yard-mzo-norte-customs",
            concept: "清关堆场服务",
            taxRate: 0.16,
            groupRates: buildSampleRatesByType(fallbackContainerTypes, 340, 90, "MXN"),
          },
        ],
      },
      {
        id: "yard-mzo-sur",
        name: "Patio Fiscal Sur",
        note: null,
        portIds: ["manzanillo"],
        shippingLineIds: sampleLineIds.slice(1, 4),
        dropoffCharges: [
          {
            id: "yard-mzo-sur-dropoff",
            concept: "落柜",
            taxRate: 0.16,
            groupRates: buildSampleRatesByType(fallbackContainerTypes, 610, 170, "MXN"),
          },
        ],
        customsCharges: [
          {
            id: "yard-mzo-sur-customs",
            concept: "清关堆场服务",
            taxRate: 0.16,
            groupRates: buildSampleRatesByType(fallbackContainerTypes, 320, 80, "MXN"),
          },
        ],
      },
      {
        id: "yard-lc-central",
        name: "Patio Central Lazaro",
        note: null,
        portIds: ["lazaro-cardenas"],
        shippingLineIds: sampleLineIds.slice(0, 3),
        dropoffCharges: [
          {
            id: "yard-lc-central-dropoff",
            concept: "落柜",
            taxRate: 0.16,
            groupRates: buildSampleRatesByType(fallbackContainerTypes, 560, 150, "MXN"),
          },
        ],
        customsCharges: [
          {
            id: "yard-lc-central-customs",
            concept: "清关堆场服务",
            taxRate: 0.16,
            groupRates: buildSampleRatesByType(fallbackContainerTypes, 300, 85, "MXN"),
          },
        ],
      },
    ],
  };
}

function normalizeCustomsModuleData(moduleData = {}, handoverModule) {
  const fallbackSeed = createDefaultCustomsSeedData(handoverModule);
  const source =
    (moduleData.ports && moduleData.ports.length) || (moduleData.yards && moduleData.yards.length)
      ? moduleData
      : fallbackSeed;
  const containerTypes = normalizeContainerTypeList(
    source.containerTypes,
    fallbackSeed.containerTypes
  );
  const shippingLines = (source.shippingLines?.length
    ? source.shippingLines
    : fallbackSeed.shippingLines
  ).map((line, index) =>
    normalizeSimpleShippingLine(line, `customs-line-${index + 1}`)
  );
  const ports = (source.ports || fallbackSeed.ports).map((port, index) =>
    normalizeCustomsPort(port, containerTypes, `customs-port-${index + 1}`)
  );
  const yards = (source.yards || fallbackSeed.yards).map((yard, index) =>
    normalizeCustomsYard(yard, containerTypes, `customs-yard-${index + 1}`)
  );

  return {
    settings: {
      defaultQuoteCurrency: normalizeCurrencyCode(
        source.settings?.defaultQuoteCurrency,
        DEFAULT_QUOTE_CURRENCY
      ),
      defaultPriceMode: normalizePriceMode(source.settings?.defaultPriceMode),
    },
    taxRatePresets: normalizeTaxRatePresets(source.taxRatePresets),
    shippingLines,
    containerTypes,
    ports,
    yards,
  };
}

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

function normalizeHandoverModuleData(moduleData = {}) {
  const shippingLines = (moduleData.shippingLines || []).map(normalizeShippingLine);

  return {
    settings: {
      defaultQuoteCurrency: normalizeCurrencyCode(
        moduleData.settings?.defaultQuoteCurrency,
        DEFAULT_QUOTE_CURRENCY
      ),
      defaultPriceMode: normalizePriceMode(moduleData.settings?.defaultPriceMode),
    },
    taxRatePresets: normalizeTaxRatePresets(moduleData.taxRatePresets),
    shippingLines,
    containerTypes: deriveContainerTypes(shippingLines),
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

  normalizedModules.inland = normalizeGenericModuleData(
    sourceModules.inland || createDefaultModuleData()
  );

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

async function getShippingData() {
  const rawData = await readSeededJson(
    shippingLinesFile,
    seedShippingLinesFile,
    { modules: {} }
  );
  return normalizeShippingData(rawData);
}

async function saveShippingData(data) {
  return writeJson(shippingLinesFile, normalizeShippingData(data));
}

async function getUsers() {
  return readSeededJson(usersFile, seedUsersFile, { users: [] });
}

async function saveUsers(data) {
  return writeJson(usersFile, data);
}

module.exports = {
  formatDemurrageRuleLabel,
  getShippingData,
  getUsers,
  normalizeShippingData,
  parseDemurrageRange,
  saveShippingData,
  saveUsers,
};
