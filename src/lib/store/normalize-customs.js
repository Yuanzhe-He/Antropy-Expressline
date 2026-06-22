// store/normalize-customs: customs module normalizer (ports / terminals / yards /
// storage rule sets + assignments + seed). Imports ./shared only.

const {
  buildContentoManzanilloYards,
} = require("../contento-yards");
const {
  DEFAULT_PRICE_MODE,
  DEFAULT_QUOTE_CURRENCY,
  DEFAULT_TAX_RATE_PRESETS,
  normalizeCurrencyCode,
  normalizePriceMode,
  normalizeTaxRate,
} = require("../options");
const {
  CUSTOMS_CONTAINER_TAXONOMY_VERSION,
  CUSTOMS_STORAGE_TIER_POLICY_VERSION,
  ensureRatesForContainerTypes,
  inferTaxRateFromMultiplier,
  migrateLegacyStorageRulesToTwoTiers,
  normalizeContainerTypeList,
  normalizeDemurrageRule,
  normalizeDemurrageRuleList,
  normalizeIdList,
  normalizeTaxRatePresets,
  parseNullableNumber,
  parseNumber,
  slugifyId,
} = require("./shared");

function normalizeSimpleShippingLine(entry, fallbackId) {
  return {
    id: entry.id || fallbackId,
    name: entry.name || fallbackId,
    active: entry.active !== false,
    notes: entry.notes || null,
    yardIds: normalizeIdList(entry.yardIds),
  };
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
    // O3 (20260617): per-charge config. basis = per_day (×storage days) | per_occurrence.
    // required = always show (even at 0). amount = optional flat (non-container) fee that
    // coexists with groupRates. Back-compat: old charges (no fields) get safe defaults.
    basis: charge.basis === "per_day" ? "per_day" : "per_occurrence",
    required: Boolean(charge.required),
    amount: parseNullableNumber(charge.amount),
    amountCurrency: normalizeCurrencyCode(charge.amountCurrency, "MXN"),
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
    // C (round-r3): the three former demo yards (Patio Norte/Sur/Central) were
    // placeholder sample data. They are replaced by the real CONTENTO Manzanillo
    // empty-return patios (método B: prices in, naviera↔patio mapping left to
    // José). Single source of truth lives in ./contento-yards.
    yards: buildContentoManzanilloYards(fallbackContainerTypes, "MXN"),
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

module.exports = {
  normalizeSimpleShippingLine,
  normalizeCustomsCharge,
  buildDefaultProgressiveRules,
  normalizeStorageRulesByContainer,
  getStorageRuleSignature,
  buildStorageRuleSetsFromContainers,
  normalizeStorageRuleSets,
  assignStorageRuleSetsToContainerTypes,
  getLineContainerAssignmentKey,
  normalizeUnassignedLineContainers,
  assignStorageRuleSetsToLineContainers,
  syncNormalizedTerminalStorageRulesByContainer,
  normalizeCustomsTerminal,
  normalizeCustomsPort,
  normalizeCustomsYard,
  buildSampleRatesByType,
  createDefaultCustomsSeedData,
  normalizeCustomsModuleData,
};
