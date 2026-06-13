const fs = require("node:fs/promises");
const path = require("node:path");
const { loadLocalEnv } = require("./env");
const {
  getAppState,
  saveAppState,
  shouldUseDatabase,
} = require("./db");
const {
  INLAND_ORIGINS,
  INLAND_DESTINATION_CATALOG,
  DEFAULT_INLAND_ORIGIN_ID,
} = require("./inland-catalog");
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

loadLocalEnv();

const bundledDataDir = path.join(__dirname, "../../data");
const dataDir = path.resolve(process.env.DATA_DIR || bundledDataDir);
const shippingLinesFile = path.join(dataDir, "shipping-lines.json");
const usersFile = path.join(dataDir, "users.json");
const seedShippingLinesFile = path.join(bundledDataDir, "shipping-lines.json");
const seedUsersFile = path.join(bundledDataDir, "users.json");
const shippingDataStateKey = "shipping-data";
const usersStateKey = "users";
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

function buildDemurrageRuleSetsFromGroups(shippingLine, containerGroups, rulesByGroup) {
  return (containerGroups || []).map((group, index) => {
    const id = `demurrage-set-${slugifyId(group.key, `group-${index + 1}`)}`;
    return {
      id,
      name: group.label || group.key || `Rule Set ${index + 1}`,
      sourceGroupKey: group.key,
      rules: normalizeDemurrageRuleList(
        rulesByGroup?.[group.key] || [],
        `${shippingLine.id || "line"}-${id}`
      ),
    };
  });
}

function normalizeDemurrageRuleSets(shippingLine, containerGroups, rulesByGroup) {
  const sourceSets = Array.isArray(shippingLine.demurrage?.ruleSets)
    ? shippingLine.demurrage.ruleSets
    : [];
  const rawSets = sourceSets.length
    ? sourceSets
    : buildDemurrageRuleSetsFromGroups(shippingLine, containerGroups, rulesByGroup);
  const seenIds = new Set();

  return rawSets.map((set, index) => {
    const fallbackId = `demurrage-set-${index + 1}`;
    let id = slugifyId(set.id, fallbackId);
    if (seenIds.has(id)) {
      id = `${id}-${index + 1}`;
    }
    seenIds.add(id);

    return {
      id,
      name: set.name || set.label || set.sourceGroupKey || `Rule Set ${index + 1}`,
      sourceGroupKey: set.sourceGroupKey || set.groupKey || null,
      rules: normalizeDemurrageRuleList(
        set.rules || [],
        `${shippingLine.id || "line"}-${id}`
      ),
    };
  });
}

function assignDemurrageRuleSetsToContainerTypes(shippingLine, ruleSets) {
  if (!ruleSets.length) {
    return {};
  }

  const validRuleSetIds = new Set(ruleSets.map((set) => set.id));
  const explicitAssignments = shippingLine.demurrage?.assignmentsByContainerType || {};
  const ruleSetByGroupKey = new Map();

  for (const set of ruleSets) {
    if (set.sourceGroupKey) {
      ruleSetByGroupKey.set(set.sourceGroupKey, set.id);
    }
  }

  const firstRuleSetId = ruleSets[0].id;
  const assignments = {};
  for (const type of STANDARD_HANDOVER_CONTAINER_TYPES) {
    const explicitRuleSetId = explicitAssignments[type.key];
    if (validRuleSetIds.has(explicitRuleSetId)) {
      assignments[type.key] = explicitRuleSetId;
      continue;
    }

    assignments[type.key] =
      (type.rateGroupKeys || [])
        .map((groupKey) => ruleSetByGroupKey.get(groupKey))
        .find(Boolean) || firstRuleSetId;
  }

  return assignments;
}

function normalizeTerminalMixRatio(value, fallback = 0) {
  const ratio = parseNumber(value, fallback);
  const normalized = ratio > 1 ? ratio / 100 : ratio;
  return Math.min(1, Math.max(0, normalized));
}

function normalizeTerminalMix(entries = []) {
  const seenIds = new Set();
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => {
      const port = String(entry.port || entry.portName || "MANZANILLO").trim();
      const terminal = String(entry.terminal || entry.terminalName || "").trim();
      if (!terminal) {
        return null;
      }

      const fallbackId = `terminal-mix-${slugifyId(port, "port")}-${slugifyId(
        terminal,
        `terminal-${index + 1}`
      )}`;
      let id = slugifyId(entry.id, fallbackId);
      if (seenIds.has(id)) {
        id = `${id}-${index + 1}`;
      }
      seenIds.add(id);

      return {
        id,
        port,
        terminal,
        ratio: normalizeTerminalMixRatio(entry.ratio, 0),
      };
    })
    .filter(Boolean);
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
  const ruleSets = normalizeDemurrageRuleSets(
    shippingLine,
    containerGroups,
    rulesByGroup
  );
  const assignmentsByContainerType = assignDemurrageRuleSetsToContainerTypes(
    shippingLine,
    ruleSets
  );

  return {
    ...shippingLine,
    invoiceToConsigneeOnly: Boolean(shippingLine.invoiceToConsigneeOnly),
    demurrageCutoffHandledBy: cutoffValid
      ? shippingLine.demurrageCutoffHandledBy
      : DEFAULT_DEMURRAGE_CUTOFF,
    containerGroups,
    localCharges,
    guarantee: normalizeGuarantee(shippingLine.guarantee),
    terminalMix: normalizeTerminalMix(shippingLine.terminalMix),
    demurrage: {
      calculationMode: "progressive",
      freeDays: {
        defaultDays: parseNumber(shippingLine.demurrage?.freeDays?.defaultDays, 0),
        daysByGroup: shippingLine.demurrage?.freeDays?.daysByGroup || {},
      },
      rulesByGroup,
      ruleSets,
      assignmentsByContainerType,
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

// Seed the editable container-type master from the built-in standard list.
// Each master entry stores only { key, label, rateGroup }; rateGroup is the
// named rate group (resolved back from the standard rateGroupKeys signature).
function buildSeedContainerTypeMaster() {
  return STANDARD_HANDOVER_CONTAINER_TYPES.map((type) => ({
    key: type.key,
    label: type.label,
    rateGroup:
      RATE_GROUP_NAME_BY_SIGNATURE.get((type.rateGroupKeys || []).join("|")) ||
      RATE_GROUP_NAMES[0],
  }));
}

// Turn persisted master entries ({ key, label, rateGroup }) into the full
// container-type objects the app uses (rateGroupKeys derived from rateGroup,
// decorated with the current shipping-line coverage).
function normalizeContainerTypeMaster(entries, shippingLines = []) {
  const lineNames = (shippingLines || [])
    .map((line) => line.name)
    .filter(Boolean)
    .sort();
  const seen = new Set();

  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const key = String(entry?.key || "").trim();
      if (!key || seen.has(key)) {
        return null;
      }
      seen.add(key);
      const rateGroup = RATE_GROUPS[entry?.rateGroup]
        ? entry.rateGroup
        : RATE_GROUP_NAME_BY_SIGNATURE.get(
            (entry?.rateGroupKeys || []).join("|")
          ) || RATE_GROUP_NAMES[0];
      return {
        key,
        label: String(entry?.label || key).trim() || key,
        rateGroup,
        rateGroupKeys: [...RATE_GROUPS[rateGroup]],
        shippingLineCount: lineNames.length,
        shippingLines: lineNames,
      };
    })
    .filter(Boolean);
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
      `${prefix}-${containerType.key}-slab-2`
    ),
  ];
}

function normalizeStorageRulesByContainer(
  storageRulesByContainer = {},
  containerTypes = [],
  prefix,
  options = {}
) {
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

    normalized[type.key] = options.migrateLegacyStorageTiers
      ? migrateLegacyStorageRulesToTwoTiers(normalizedRules)
      : normalizedRules;
  }
  return normalized;
}

function getStorageRuleSignature(rules = []) {
  return JSON.stringify(
    (rules || []).map((rule) => ({
      startDay: rule.startDay,
      endDay: rule.endDay,
      freeRule: rule.freeRule,
      taxRate: rule.taxRate,
      rate: rule.rateConfig?.rate || 0,
      currency: rule.rateConfig?.currency || DEFAULT_QUOTE_CURRENCY,
      qtyHint: rule.rateConfig?.qtyHint || 1,
    }))
  );
}

function buildStorageRuleSetsFromContainers(terminal, containerTypes, rulesByContainer) {
  const groups = new Map();

  for (const [index, type] of (containerTypes || []).entries()) {
    const rules = normalizeDemurrageRuleList(
      rulesByContainer?.[type.key] || [],
      `${terminal.id || "terminal"}-storage-set-${type.key}`
    );
    const signature = getStorageRuleSignature(rules);
    const existingGroup = groups.get(signature);

    if (existingGroup) {
      existingGroup.sourceContainerKeys.push(type.key);
      continue;
    }

    groups.set(signature, {
      id: `storage-set-${slugifyId(type.key, `type-${index + 1}`)}`,
      name: type.label || type.key || `Storage ${index + 1}`,
      sourceContainerKey: type.key,
      sourceContainerKeys: [type.key],
      rules,
    });
  }

  return [...groups.values()];
}

function normalizeStorageRuleSets(
  terminal,
  containerTypes,
  rulesByContainer,
  options = {}
) {
  const sourceSets = Array.isArray(terminal.storageRuleSets)
    ? terminal.storageRuleSets
    : [];
  // After unifying customs container types with handover, the persisted rule
  // sets are keyed to the old taxonomy and can no longer be assigned to any
  // current container. options.rebuildStorageRuleSets is a one-time taxonomy
  // migration (gated by containerTaxonomyVersion) that rebuilds them from the
  // current container types.
  const rawSets = sourceSets.length && !options.rebuildStorageRuleSets
    ? sourceSets
    : buildStorageRuleSetsFromContainers(terminal, containerTypes, rulesByContainer);
  const seenIds = new Set();

  return rawSets.map((set, index) => {
    const fallbackId = `storage-set-${index + 1}`;
    let id = slugifyId(set.id, fallbackId);
    if (seenIds.has(id)) {
      id = `${id}-${index + 1}`;
    }
    seenIds.add(id);

    const name = set.name || set.label || set.sourceContainerKey || `Storage ${index + 1}`;
    const rules = normalizeDemurrageRuleList(
      set.rules || [],
      `${terminal.id || "terminal"}-${id}`
    );
    const migratedRules = options.migrateLegacyStorageTiers
      ? migrateLegacyStorageRulesToTwoTiers(rules)
      : rules;

    return {
      id,
      name,
      sourceContainerKey: set.sourceContainerKey || set.containerTypeKey || null,
      sourceContainerKeys: [
        ...new Set(
          [
            ...(Array.isArray(set.sourceContainerKeys)
              ? set.sourceContainerKeys
              : []),
            set.sourceContainerKey,
            set.containerTypeKey,
          ].filter(Boolean)
        ),
      ],
      rules: migratedRules.length
        ? migratedRules
        : buildDefaultProgressiveRules(
            { key: id, label: name },
            `${terminal.id || "terminal"}-${id}`
          ),
    };
  });
}

function assignStorageRuleSetsToContainerTypes(terminal, containerTypes, ruleSets) {
  if (!ruleSets.length) {
    return {};
  }

  const validRuleSetIds = new Set(ruleSets.map((set) => set.id));
  const explicitAssignments = terminal.storageAssignmentsByContainerType || {};
  const ruleSetByContainerKey = new Map();

  for (const set of ruleSets) {
    if (set.sourceContainerKey) {
      ruleSetByContainerKey.set(set.sourceContainerKey, set.id);
    }
    for (const sourceContainerKey of set.sourceContainerKeys || []) {
      ruleSetByContainerKey.set(sourceContainerKey, set.id);
    }
  }

  const firstRuleSetId = ruleSets[0].id;
  const assignments = {};
  for (const type of containerTypes || []) {
    const explicitRuleSetIds = Array.isArray(explicitAssignments[type.key])
      ? explicitAssignments[type.key]
      : [explicitAssignments[type.key]].filter(Boolean);
    const validExplicitRuleSetId = explicitRuleSetIds.find((ruleSetId) =>
      validRuleSetIds.has(ruleSetId)
    );
    if (validExplicitRuleSetId) {
      assignments[type.key] = validExplicitRuleSetId;
      continue;
    }

    assignments[type.key] = ruleSetByContainerKey.get(type.key) || firstRuleSetId;
  }

  return assignments;
}

function getLineContainerAssignmentKey(lineId, containerTypeKey) {
  return `${lineId}::${containerTypeKey}`;
}

function normalizeUnassignedLineContainers(terminal, shippingLines, containerTypes) {
  const validKeys = new Set();
  for (const line of shippingLines || []) {
    for (const type of containerTypes || []) {
      validKeys.add(getLineContainerAssignmentKey(line.id, type.key));
    }
  }

  return normalizeIdList(terminal.storageUnassignedLineContainers).filter((key) =>
    validKeys.has(key)
  );
}

function assignStorageRuleSetsToLineContainers({
  terminal,
  shippingLines,
  containerTypes,
  ruleSets,
  fallbackAssignmentsByContainerType,
  unassignedLineContainers,
}) {
  if (!ruleSets.length) {
    return {};
  }

  const validRuleSetIds = new Set(ruleSets.map((set) => set.id));
  const explicitAssignments = terminal.storageAssignmentsByLineContainer || {};
  const unassignedKeys = new Set(unassignedLineContainers || []);
  const assignments = {};

  for (const line of shippingLines || []) {
    assignments[line.id] = {};

    for (const type of containerTypes || []) {
      const assignmentKey = getLineContainerAssignmentKey(line.id, type.key);
      if (unassignedKeys.has(assignmentKey)) {
        continue;
      }

      const explicitValue = explicitAssignments[line.id]?.[type.key];
      const explicitRuleSetId = Array.isArray(explicitValue)
        ? explicitValue.find((ruleSetId) => validRuleSetIds.has(ruleSetId))
        : explicitValue;
      if (validRuleSetIds.has(explicitRuleSetId)) {
        assignments[line.id][type.key] = explicitRuleSetId;
        continue;
      }

      const fallbackValue = fallbackAssignmentsByContainerType?.[type.key];
      const fallbackRuleSetId = Array.isArray(fallbackValue)
        ? fallbackValue.find((ruleSetId) => validRuleSetIds.has(ruleSetId))
        : fallbackValue;
      if (validRuleSetIds.has(fallbackRuleSetId)) {
        assignments[line.id][type.key] = fallbackRuleSetId;
        continue;
      }

      assignments[line.id][type.key] = ruleSets[0].id;
    }

    if (!Object.keys(assignments[line.id]).length) {
      delete assignments[line.id];
    }
  }

  return assignments;
}

function syncNormalizedTerminalStorageRulesByContainer(
  terminal,
  shippingLines = [],
  containerTypes = []
) {
  const ruleSets = Array.isArray(terminal.storageRuleSets)
    ? terminal.storageRuleSets
    : [];
  if (!ruleSets.length) {
    return;
  }

  const lineAssignments = terminal.storageAssignmentsByLineContainer || {};
  const containerAssignments = terminal.storageAssignmentsByContainerType || {};
  const validRuleSetIds = new Set(ruleSets.map((ruleSet) => ruleSet.id));
  const unassignedKeys = new Set(terminal.storageUnassignedLineContainers || []);
  terminal.storageAssignmentsByLineContainer = {};
  terminal.storageAssignmentsByContainerType = {};
  terminal.storageRulesByContainer = terminal.storageRulesByContainer || {};

  for (const line of shippingLines || []) {
    terminal.storageAssignmentsByLineContainer[line.id] = {};

    for (const type of containerTypes || []) {
      const assignmentKey = getLineContainerAssignmentKey(line.id, type.key);
      if (unassignedKeys.has(assignmentKey)) {
        continue;
      }

      const assignedRuleSetId = lineAssignments[line.id]?.[type.key];
      let ruleSetId = validRuleSetIds.has(assignedRuleSetId)
        ? assignedRuleSetId
        : null;

      if (!ruleSetId) {
        const containerRuleSetId = containerAssignments[type.key];
        ruleSetId = validRuleSetIds.has(containerRuleSetId)
          ? containerRuleSetId
          : null;
      }

      if (!ruleSetId) {
        ruleSetId =
          ruleSets.find((ruleSet) => ruleSet.sourceContainerKey === type.key)
            ?.id || ruleSets[0].id;
      }

      terminal.storageAssignmentsByLineContainer[line.id][type.key] = ruleSetId;
    }

    if (!Object.keys(terminal.storageAssignmentsByLineContainer[line.id]).length) {
      delete terminal.storageAssignmentsByLineContainer[line.id];
    }
  }

  const firstLineId = shippingLines?.[0]?.id;
  for (const type of containerTypes || []) {
    const ruleSetId =
      firstLineId &&
      terminal.storageAssignmentsByLineContainer[firstLineId]?.[type.key];
    const ruleSet =
      ruleSets.find((entry) => entry.id === ruleSetId) || ruleSets[0];
    terminal.storageAssignmentsByContainerType[type.key] = ruleSet.id;
    terminal.storageRulesByContainer[type.key] = structuredClone(
      ruleSet.rules || []
    );
  }
}

function normalizeCustomsTerminal(
  terminal,
  shippingLines,
  containerTypes,
  fallbackId,
  options = {}
) {
  const id = terminal.id || fallbackId;
  const storageRulesByContainer = normalizeStorageRulesByContainer(
    terminal.storageRulesByContainer,
    containerTypes,
    `${id}-storage`,
    options
  );
  const storageRuleSets = normalizeStorageRuleSets(
    { ...terminal, id },
    containerTypes,
    storageRulesByContainer,
    options
  );
  const storageAssignmentsByContainerType = assignStorageRuleSetsToContainerTypes(
    terminal,
    containerTypes,
    storageRuleSets
  );
  const storageUnassignedLineContainers = normalizeUnassignedLineContainers(
    terminal,
    shippingLines,
    containerTypes
  );
  const storageAssignmentsByLineContainer = assignStorageRuleSetsToLineContainers({
    terminal,
    shippingLines,
    containerTypes,
    ruleSets: storageRuleSets,
    fallbackAssignmentsByContainerType: storageAssignmentsByContainerType,
    unassignedLineContainers: storageUnassignedLineContainers,
  });

  const normalizedTerminal = {
    id,
    name: terminal.name || fallbackId,
    note: terminal.note || null,
    fixedCharges: (terminal.fixedCharges || []).map((charge, index) =>
      normalizeCustomsCharge(
        charge,
        `${id}-fixed-${index + 1}`,
        containerTypes
      )
    ),
    storageRulesByContainer,
    storageRuleSets,
    storageAssignmentsByContainerType,
    storageAssignmentsByLineContainer,
    storageUnassignedLineContainers,
  };
  syncNormalizedTerminalStorageRulesByContainer(
    normalizedTerminal,
    shippingLines,
    containerTypes
  );
  return normalizedTerminal;
}

function normalizeCustomsPort(
  port,
  shippingLines,
  containerTypes,
  fallbackId,
  options = {}
) {
  return {
    id: port.id || fallbackId,
    name: port.name || fallbackId,
    note: port.note || null,
    terminals: (port.terminals || []).map((terminal, index) =>
      normalizeCustomsTerminal(
        terminal,
        shippingLines,
        containerTypes,
        `${port.id || fallbackId}-terminal-${index + 1}`,
        options
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
                    endDay: null,
                    taxRate: 0.16,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 115 + index * 25,
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
                    id: `ssa-${type.key}-tier-2`,
                    startDay: 8,
                    endDay: null,
                    taxRate: 0.16,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 130 + index * 20,
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
                    endDay: null,
                    taxRate: 0.16,
                    rateConfig: {
                      label: type.label,
                      qtyHint: 1,
                      currency: "MXN",
                      rate: 120 + index * 25,
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
  // Customs container types are kept identical to the handover module so both
  // quote flows share the same container vocabulary (key + label + order).
  // The customs taxonomy has no key overlap with handover, so per-container
  // rate maps re-key onto handover keys (missing rates default to 0) and stale
  // storage rule sets are regenerated downstream in normalizeStorageRuleSets.
  const handoverContainerTypes = (handoverModule?.containerTypes || []).map((type) => ({
    key: type.key,
    label: type.label,
  }));
  const containerTypes = handoverContainerTypes.length
    ? handoverContainerTypes
    : normalizeContainerTypeList(
        Array.isArray(source.containerTypes) ? source.containerTypes : [],
        fallbackSeed.containerTypes
      );
  const shippingLines = (source.shippingLines?.length
    ? source.shippingLines
    : fallbackSeed.shippingLines
  ).map((line, index) =>
    normalizeSimpleShippingLine(line, `customs-line-${index + 1}`)
  );
  const storageTierPolicyVersion = parseNumber(
    source.settings?.storageTierPolicyVersion,
    0
  );
  const containerTaxonomyVersion = parseNumber(
    source.settings?.containerTaxonomyVersion,
    0
  );
  const normalizeOptions = {
    migrateLegacyStorageTiers:
      storageTierPolicyVersion < CUSTOMS_STORAGE_TIER_POLICY_VERSION,
    rebuildStorageRuleSets:
      containerTaxonomyVersion < CUSTOMS_CONTAINER_TAXONOMY_VERSION,
  };
  const ports = (source.ports || fallbackSeed.ports).map((port, index) =>
    normalizeCustomsPort(
      port,
      shippingLines,
      containerTypes,
      `customs-port-${index + 1}`,
      normalizeOptions
    )
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
      storageTierPolicyVersion: CUSTOMS_STORAGE_TIER_POLICY_VERSION,
      containerTaxonomyVersion: CUSTOMS_CONTAINER_TAXONOMY_VERSION,
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

  // Container types come from an editable master persisted on the handover
  // module. On first load (or a version bump) seed it from the standard list;
  // afterwards persisted edits win. Customs derives its types from this master.
  const masterVersion = parseNumber(
    moduleData.settings?.containerTypeMasterVersion,
    0
  );
  const seedMaster =
    masterVersion < CONTAINER_TYPE_MASTER_VERSION ||
    !Array.isArray(moduleData.containerTypes) ||
    !moduleData.containerTypes.length;
  const containerTypes = normalizeContainerTypeMaster(
    seedMaster ? buildSeedContainerTypeMaster() : moduleData.containerTypes,
    shippingLines
  );

  return {
    settings: {
      defaultQuoteCurrency: normalizeCurrencyCode(
        moduleData.settings?.defaultQuoteCurrency,
        DEFAULT_QUOTE_CURRENCY
      ),
      defaultPriceMode: normalizePriceMode(moduleData.settings?.defaultPriceMode),
      containerTypeMasterVersion: CONTAINER_TYPE_MASTER_VERSION,
    },
    taxRatePresets: normalizeTaxRatePresets(moduleData.taxRatePresets),
    shippingLines,
    containerTypes,
  };
}

// Bumped to (re)seed the inland destination catalog from INLAND_DESTINATION_CATALOG.
const INLAND_SEED_VERSION = 1;

function parseNullableNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeInlandPrecisePoint(point = {}, fallbackId) {
  return {
    id: slugifyId(point.id, fallbackId),
    name: String(point.name || "").trim() || fallbackId,
    lat: parseNullableNumber(point.lat),
    lng: parseNullableNumber(point.lng),
    note: String(point.note || ""),
    source: ["gmaps-link", "manual", "seed-catalog"].includes(point.source)
      ? point.source
      : "manual",
    link: typeof point.link === "string" ? point.link : "",
  };
}

function normalizeInlandDestination(dest = {}, fallbackId) {
  const id = slugifyId(dest.id, fallbackId);
  return {
    id,
    name: String(dest.name || id).trim(),
    state: String(dest.state || "").trim(),
    lat: parseNullableNumber(dest.lat),
    lng: parseNullableNumber(dest.lng),
    coordSource: ["seed-catalog", "gmaps-link", "manual"].includes(dest.coordSource)
      ? dest.coordSource
      : "seed-catalog",
    needsReview: Boolean(dest.needsReview),
    precisePoints: (Array.isArray(dest.precisePoints) ? dest.precisePoints : []).map(
      (point, index) => normalizeInlandPrecisePoint(point, `${id}-pp-${index + 1}`)
    ),
    enabled: dest.enabled !== false,
    note: String(dest.note || ""),
  };
}

function normalizeInlandRateEntry(entry = {}, fallbackId) {
  return {
    id: slugifyId(entry.id, fallbackId),
    originId:
      slugifyId(entry.originId, DEFAULT_INLAND_ORIGIN_ID) ||
      DEFAULT_INLAND_ORIGIN_ID,
    destinationId: String(entry.destinationId || "").trim(),
    proveedor: String(entry.proveedor || "").trim(),
    dupIndex:
      Number.isInteger(entry.dupIndex) && entry.dupIndex > 0 ? entry.dupIndex : 1,
    sencillo: parseNullableNumber(entry.sencillo),
    full: parseNullableNumber(entry.full),
    currency: "MXN",
    cliente: String(entry.cliente || "").trim(),
    codigoCw: String(entry.codigoCw || "").trim(),
    commodity: String(entry.commodity || "").trim(),
    enabled: entry.enabled !== false,
    note: String(entry.note || ""),
    extras:
      entry.extras && typeof entry.extras === "object" && !Array.isArray(entry.extras)
        ? entry.extras
        : {},
  };
}

function normalizeInlandRouteCacheEntry(rc = {}, fallbackId) {
  return {
    id: slugifyId(rc.id, fallbackId),
    originId:
      slugifyId(rc.originId, DEFAULT_INLAND_ORIGIN_ID) || DEFAULT_INLAND_ORIGIN_ID,
    destinationId: String(rc.destinationId || "").trim(),
    targetType: rc.targetType === "precisePoint" ? "precisePoint" : "destination",
    targetId: rc.targetId ? String(rc.targetId).trim() : null,
    encodedPolyline: typeof rc.encodedPolyline === "string" ? rc.encodedPolyline : "",
    distanceKm: parseNullableNumber(rc.distanceKm),
    durationMin: parseNullableNumber(rc.durationMin),
    viaCities: Array.isArray(rc.viaCities)
      ? rc.viaCities.map((city) => String(city)).filter(Boolean)
      : [],
    engine: String(rc.engine || "osrm"),
    fetchedAt: rc.fetchedAt || null,
    stale: Boolean(rc.stale),
    hasFerry: Boolean(rc.hasFerry),
  };
}

function buildInlandDestinationSeed() {
  return INLAND_DESTINATION_CATALOG.map((dest) => ({
    id: dest.id,
    name: dest.name,
    state: dest.state,
    lat: dest.lat,
    lng: dest.lng,
    coordSource: "seed-catalog",
    needsReview: Boolean(dest.needsReview),
    precisePoints: [],
    enabled: true,
    note: "",
  }));
}

function normalizeInlandModuleData(moduleData = {}) {
  const seedVersion = parseNumber(moduleData.settings?.inlandSeedVersion, 0);
  const seedNeeded =
    seedVersion < INLAND_SEED_VERSION ||
    !Array.isArray(moduleData.destinations) ||
    !moduleData.destinations.length;

  const origins = (
    Array.isArray(moduleData.origins) && moduleData.origins.length
      ? moduleData.origins
      : INLAND_ORIGINS
  ).map((origin, index) => ({
    id: slugifyId(origin.id, `origin-${index + 1}`),
    name: String(origin.name || origin.id || `Origin ${index + 1}`).trim(),
    lat: parseNullableNumber(origin.lat),
    lng: parseNullableNumber(origin.lng),
  }));

  const destinations = (
    seedNeeded ? buildInlandDestinationSeed() : moduleData.destinations
  ).map((dest, index) => normalizeInlandDestination(dest, `dest-${index + 1}`));
  const destinationIds = new Set(destinations.map((dest) => dest.id));

  const rateEntries = (
    Array.isArray(moduleData.rateEntries) ? moduleData.rateEntries : []
  )
    .map((entry, index) => normalizeInlandRateEntry(entry, `re-${index + 1}`))
    .filter((entry) => destinationIds.has(entry.destinationId));

  const routeCache = (
    Array.isArray(moduleData.routeCache) ? moduleData.routeCache : []
  )
    .map((rc, index) => normalizeInlandRouteCacheEntry(rc, `rc-${index + 1}`))
    .filter((rc) => destinationIds.has(rc.destinationId));

  return {
    settings: {
      defaultQuoteCurrency: "MXN",
      defaultPriceMode: normalizePriceMode(moduleData.settings?.defaultPriceMode),
      inlandSeedVersion: INLAND_SEED_VERSION,
    },
    taxRatePresets: normalizeTaxRatePresets(moduleData.taxRatePresets),
    origins,
    destinations,
    rateEntries,
    routeCache,
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
  if (shouldUseDatabase()) {
    const storedData = await getAppState(shippingDataStateKey);
    if (storedData) {
      return normalizeShippingData(storedData);
    }

    const seedData = await readSeededJson(
      shippingLinesFile,
      seedShippingLinesFile,
      { modules: {} }
    );
    const normalizedData = normalizeShippingData(seedData);
    await saveAppState(shippingDataStateKey, normalizedData);
    return normalizedData;
  }

  const rawData = await readSeededJson(
    shippingLinesFile,
    seedShippingLinesFile,
    { modules: {} }
  );
  return normalizeShippingData(rawData);
}

async function saveShippingData(data) {
  if (shouldUseDatabase()) {
    return saveAppState(shippingDataStateKey, normalizeShippingData(data));
  }

  return writeJson(shippingLinesFile, normalizeShippingData(data));
}

async function getUsers() {
  if (shouldUseDatabase()) {
    const storedUsers = await getAppState(usersStateKey);
    if (storedUsers) {
      return storedUsers;
    }

    const seedUsers = await readSeededJson(usersFile, seedUsersFile, {
      users: [],
    });
    await saveAppState(usersStateKey, seedUsers);
    return seedUsers;
  }

  return readSeededJson(usersFile, seedUsersFile, { users: [] });
}

async function saveUsers(data) {
  if (shouldUseDatabase()) {
    return saveAppState(usersStateKey, data);
  }

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
  RATE_GROUP_NAMES,
};
