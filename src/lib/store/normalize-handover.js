// store/normalize-handover: handover module normalizer (shipping lines, demurrage
// rule sets, terminal mix, container-type master). Imports ./shared only.

const {
  DEFAULT_DEMURRAGE_CUTOFF,
  DEFAULT_QUOTE_CURRENCY,
  DEMURRAGE_CUTOFF_OPTIONS,
  normalizeCurrencyCode,
  normalizePriceMode,
  normalizeTaxRate,
} = require("../options");
const {
  CONTAINER_TYPE_MASTER_VERSION,
  LEGACY_NAME_BY_SIZED_GROUP,
  RATE_GROUPS,
  RATE_GROUP_NAMES,
  RATE_GROUP_NAME_BY_SIGNATURE,
  STANDARD_HANDOVER_CONTAINER_TYPES,
  sizedKeysGroup,
  formatDemurrageRuleLabel,
  inferTaxRateFromMultiplier,
  normalizeCharge,
  normalizeDemurrageRule,
  normalizeDemurrageRuleList,
  normalizeDemurrageTier,
  normalizeGroupRates,
  normalizeRateConfig,
  normalizeTaxRatePresets,
  parseNumber,
  slugifyId,
} = require("./shared");

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

// Shape a shipping line's `notes` so `code` (CODIGO DE NAVIERA) and `rfc`
// (Mexican tax id) always exist. Extra keys (e.g. sourceSheet) are preserved.

function normalizeShippingLineNotes(notes) {
  if (notes && typeof notes === "object") {
    return {
      ...notes,
      sourceSheet: notes.sourceSheet ?? null,
      code: notes.code ?? null,
      rfc: notes.rfc ?? null,
    };
  }
  return { sourceSheet: null, code: null, rfc: null };
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
    // E (round-r3): carrier metadata for invoicing. `code` = CODIGO DE NAVIERA,
    // `rfc` = Mexican tax id (RFC / TAX ID). Back-compat: old data without rfc
    // defaults to null; missing notes becomes a shaped object.
    notes: normalizeShippingLineNotes(shippingLine.notes),
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
  return STANDARD_HANDOVER_CONTAINER_TYPES.map((type) => {
    const signatureName =
      RATE_GROUP_NAME_BY_SIGNATURE.get((type.rateGroupKeys || []).join("|")) ||
      RATE_GROUP_NAMES[0];
    return {
      key: type.key,
      label: type.label,
      // Sized variants (dry20/…) are key-derivation internals — persist the
      // legacy name so any build, old or new, resolves the seed identically.
      rateGroup: LEGACY_NAME_BY_SIZED_GROUP[signatureName] || signatureName,
    };
  });
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
      const resolvedName = RATE_GROUPS[entry?.rateGroup]
        ? entry.rateGroup
        : RATE_GROUP_NAME_BY_SIGNATURE.get(
            (entry?.rateGroupKeys || []).join("|")
          ) || RATE_GROUP_NAMES[0];
      // Persisted names stay LEGACY (a sized name is normalized back), while
      // the candidate KEYS come from the per-size variant for the mixed-size
      // groups. Keeping sized names out of the data is what makes a code
      // rollback inert.
      const rateGroup = LEGACY_NAME_BY_SIZED_GROUP[resolvedName] || resolvedName;
      return {
        key,
        label: String(entry?.label || key).trim() || key,
        rateGroup,
        rateGroupKeys: [...RATE_GROUPS[sizedKeysGroup(rateGroup, key)]],
        shippingLineCount: lineNames.length,
        shippingLines: lineNames,
      };
    })
    .filter(Boolean);
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
// v2: morelos/edomex confirmed (needsReview cleared, coordSource seed-catalog-confirmed);
// the bump re-seeds persisted destinations so the confirmation reaches existing stores.

module.exports = {
  normalizeGuarantee,
  buildLegacyDemurrageRulesByGroup,
  normalizeDemurrageRulesByGroup,
  buildDemurrageRuleSetsFromGroups,
  normalizeDemurrageRuleSets,
  assignDemurrageRuleSetsToContainerTypes,
  normalizeTerminalMixRatio,
  normalizeTerminalMix,
  normalizeShippingLineNotes,
  normalizeShippingLine,
  deriveContainerTypes,
  buildSeedContainerTypeMaster,
  normalizeContainerTypeMaster,
  normalizeHandoverModuleData,
};
