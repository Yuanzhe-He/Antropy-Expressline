const express = require("express");
const session = require("express-session");
const path = require("node:path");
const {
  computeCalculator,
  computeCustomsCalculator,
  computeInlandCalculator,
  parseNumber,
} = require("./lib/calculate");
const { resolveLink } = require("./lib/inland-link-resolver");
const {
  fetchOsrmRoute,
  decodePolyline,
  computeViaCities,
  getRoutingProvider,
  effectiveRoute,
} = require("./lib/inland-routes");
const {
  VEHICLE_TYPE_KEYS,
  EXTRA_VEHICLE_KEYS,
  normalizeVehicleType,
  getVehiclePrice,
} = require("./lib/inland-vehicles");
const { refreshExchangeRatesIfStale } = require("./lib/exchange-rates");
const { startExchangeRateScheduler } = require("./lib/exchange-rate-scheduler");
const {
  buildTranslator,
  getLanguageOptions,
  getModulePresentation,
  getModulePresentations,
  normalizeLanguage,
} = require("./lib/i18n");
const {
  DEFAULT_MODULE_KEY,
  getBusinessModule,
  normalizeModuleKey,
} = require("./lib/modules");
const {
  BUSINESS_NATURE_OPTIONS,
  CURRENCY_OPTIONS,
  DEMURRAGE_CUTOFF_OPTIONS,
  PRICE_MODE_OPTIONS,
  getDemurrageCutoffLabel,
  getTaxRateLabel,
  getLocalizedOptions,
  normalizeBusinessNature,
} = require("./lib/options");
const {
  formatDemurrageRuleLabel,
  getShippingData,
  getUsers,
  localizedInlandName,
  saveShippingData,
  RATE_GROUP_NAMES,
} = require("./lib/store");
const {
  DEFAULT_QUOTE_HEADER,
  QUOTE_DEPARTMENT_OPTIONS,
  QUOTE_INCOTERM_OPTIONS,
  QUOTE_TRANSPORT_MODE_OPTIONS,
  QUOTE_CARGO_TYPE_OPTIONS,
  QUOTE_UOM_OPTIONS,
  buildInitialLineItems,
  computeQuoteTotals,
  groupRowsForRender,
  groupRowsBySection,
  pullCalculatorValues,
  generateQuoteNumber,
  loadFeeCodes,
  resolveQuoteRoute,
} = require("./lib/quote");
const { renderQuotePdf } = require("./lib/quote-pdf");
const { shouldUseDatabase, insertQuoteSnapshot } = require("./lib/db");

const port = process.env.PORT || 3000;
const sessionSecret =
  process.env.SESSION_SECRET || "jose-expressline-consulting-local";
const publicDemoUser = Object.freeze({
  id: "public-demo",
  name: "Express Line",
  role: "admin",
  username: "public",
});

function requireAuth(req, res, next) {
  req.session.user = req.session.user || publicDemoUser;
  return next();
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function uniqueIds(values) {
  return [...new Set(values.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function parseWholeNumber(value, fallback = 0) {
  return Math.max(0, Math.trunc(parseNumber(value, fallback)));
}

function buildRuleId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneRateConfig(rateConfig = {}) {
  return {
    label: rateConfig.label || "",
    qtyHint: parseNumber(rateConfig.qtyHint, 1) || 1,
    currency: rateConfig.currency || "MXN",
    rate: parseNumber(rateConfig.rate, 0),
  };
}

function appendProgressiveRule(rules, prefix, label) {
  if (!rules.length) {
    rules.push({
      id: buildRuleId(prefix),
      label: "0-0",
      note: null,
      startDay: 1,
      endDay: null,
      freeRule: true,
      taxRate: 0,
      rateConfig: {
        label,
        qtyHint: 1,
        currency: "MXN",
        rate: 0,
      },
    });
    return;
  }

  const lastRule = rules[rules.length - 1];
  const anchorDay = lastRule.endDay ?? lastRule.startDay ?? 1;
  if (lastRule.endDay === null) {
    lastRule.endDay = anchorDay;
  }

  rules.push({
    id: buildRuleId(prefix),
    label: `>${anchorDay}`,
    note: null,
    startDay: anchorDay + 1,
    endDay: null,
    freeRule: false,
    taxRate: parseNumber(lastRule.taxRate, 0),
    rateConfig: cloneRateConfig({
      ...lastRule.rateConfig,
      label,
    }),
  });
}

function resequenceRules(rules) {
  let nextStart = 1;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    rule.startDay = nextStart;
    if (rule.endDay !== null && rule.endDay < nextStart) {
      rule.endDay = nextStart;
    }
    rule.freeRule = Number(rule.rateConfig?.rate || 0) === 0;
    rule.label = formatDemurrageRuleLabel(
      rule.startDay,
      rule.endDay,
      rule.freeRule
    );
    if (rule.endDay !== null) {
      nextStart = rule.endDay + 1;
    }
  }
}

function removeProgressiveRule(rules, ruleId) {
  if (!rules.length || rules.length === 1) {
    return false;
  }

  const ruleIndex = rules.findIndex((rule) => rule.id === ruleId);
  if (ruleIndex < 0) {
    return false;
  }

  rules.splice(ruleIndex, 1);
  return true;
}

function unassignStorageRuleSetAssignments(
  terminal,
  ruleSetId,
  shippingLines = [],
  containerTypes = []
) {
  const unassignedKeys = new Set(terminal.storageUnassignedLineContainers || []);
  let count = 0;

  for (const line of shippingLines || []) {
    const lineAssignments =
      terminal.storageAssignmentsByLineContainer?.[line.id] || {};
    for (const type of containerTypes || []) {
      if (lineAssignments[type.key] !== ruleSetId) {
        continue;
      }
      delete lineAssignments[type.key];
      unassignedKeys.add(getLineContainerAssignmentKey(line.id, type.key));
      count += 1;
    }

    if (
      terminal.storageAssignmentsByLineContainer?.[line.id] &&
      !Object.keys(lineAssignments).length
    ) {
      delete terminal.storageAssignmentsByLineContainer[line.id];
    }
  }

  for (const [typeKey, assignedRuleSetId] of Object.entries(
    terminal.storageAssignmentsByContainerType || {}
  )) {
    if (assignedRuleSetId === ruleSetId) {
      delete terminal.storageAssignmentsByContainerType[typeKey];
    }
  }

  terminal.storageUnassignedLineContainers = uniqueIds([...unassignedKeys]);
  return count;
}

function applySequentialRuleUpdates({
  rules,
  body,
  getPrefix,
  t,
}) {
  let nextStart = 1;

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const prefix = getPrefix(rule);
    const rawEnd = body[`${prefix}_end`];
    const endDay = rawEnd === "" ? null : parseWholeNumber(rawEnd, rule.endDay);

    if (endDay !== null && endDay < nextStart) {
      return {
        ok: false,
        message: t("admin.invalidRuleRange", {
          start: nextStart,
          end: endDay,
        }),
      };
    }

    if (endDay === null && index < rules.length - 1) {
      return {
        ok: false,
        message: t("admin.openEndedRuleMustBeLast"),
      };
    }

    rule.startDay = nextStart;
    rule.endDay = endDay;
    rule.taxRate = parseNumber(body[`${prefix}_tax`], rule.taxRate);
    applyRateCellUpdates(rule.rateConfig, body, prefix);
    rule.freeRule = Number(rule.rateConfig?.rate || 0) === 0;
    rule.label = formatDemurrageRuleLabel(
      rule.startDay,
      rule.endDay,
      rule.freeRule
    );

    if (rule.endDay !== null) {
      nextStart = rule.endDay + 1;
    }
  }

  return { ok: true };
}

function redirectWithFlash(req, res, type, message, target) {
  req.session.flash = { type, message };
  return res.redirect(target);
}

function findCustomsTerminal(moduleData, terminalId) {
  for (const portEntry of moduleData.ports || []) {
    const terminal = (portEntry.terminals || []).find(
      (entry) => entry.id === terminalId
    );
    if (terminal) {
      return { portEntry, terminal };
    }
  }
  return { portEntry: null, terminal: null };
}

function buildZeroRatesByContainer(containerTypes = [], currency = "MXN") {
  return Object.fromEntries(
    (containerTypes || []).map((type) => [
      type.key,
      {
        label: type.label,
        qtyHint: 1,
        currency,
        rate: 0,
      },
    ])
  );
}

function inferLocalChargeCurrency(shippingLine, moduleData) {
  for (const charge of shippingLine.localCharges || []) {
    if (charge.blRate?.currency) {
      return charge.blRate.currency;
    }

    const groupRate = Object.values(charge.groupRates || {}).find(
      (rate) => rate?.currency
    );
    if (groupRate?.currency) {
      return groupRate.currency;
    }
  }

  return (
    shippingLine.quoteDefaults?.quoteCurrency ||
    moduleData.settings?.defaultQuoteCurrency ||
    "USD"
  );
}

function buildLocalChargeDraft(shippingLine, moduleData, t) {
  const localCharges = shippingLine.localCharges || [];
  const currency = inferLocalChargeCurrency(shippingLine, moduleData);
  const id = buildRuleId(`${shippingLine.id}-local-charge`);

  return {
    id,
    concept: t("admin.newLocalChargeName", { count: localCharges.length + 1 }),
    note: null,
    taxRate: 0,
    groupRates: buildZeroRatesByContainer(
      shippingLine.containerGroups || moduleData.containerTypes || [],
      currency
    ),
    blRate: {
      qtyHint: 1,
      currency,
      rate: 0,
    },
  };
}

function buildDefaultCustomsStorageRules(
  containerTypes = [],
  prefix,
  currency = "MXN"
) {
  return Object.fromEntries(
    (containerTypes || []).map((type) => [
      type.key,
      [
        {
          id: buildRuleId(`${prefix}-${type.key}-free`),
          startDay: 1,
          endDay: 7,
          freeRule: true,
          taxRate: 0,
          rateConfig: {
            label: type.label,
            qtyHint: 1,
            currency,
            rate: 0,
          },
        },
        {
          id: buildRuleId(`${prefix}-${type.key}-tier`),
          startDay: 8,
          endDay: null,
          freeRule: false,
          taxRate: 0,
          rateConfig: {
            label: type.label,
            qtyHint: 1,
            currency,
            rate: 0,
          },
        },
      ],
    ])
  );
}

function buildCustomsStorageRuleSetDraft(moduleData, terminal, t) {
  const index = (terminal.storageRuleSets || []).length + 1;
  const id = buildRuleId(`${terminal.id}-storage-set`);
  const name = t("customs.newStorageRuleSetName", { count: index });
  const currency = moduleData.settings?.defaultQuoteCurrency || "MXN";
  const sampleType = moduleData.containerTypes?.[0] || {
    key: "storage",
    label: name,
  };
  const rules =
    buildDefaultCustomsStorageRules([sampleType], `${id}-rules`, currency)[
      sampleType.key
    ] || [];

  return {
    id,
    name,
    sourceContainerKey: null,
    rules: rules.map((rule) => ({
      ...rule,
      rateConfig: {
        ...rule.rateConfig,
        label: name,
      },
    })),
  };
}

function findAssignedStorageRuleSet(terminal, containerTypeKey) {
  const ruleSets = Array.isArray(terminal.storageRuleSets)
    ? terminal.storageRuleSets
    : [];
  if (!ruleSets.length) {
    return null;
  }

  const assignedRuleSetId =
    terminal.storageAssignmentsByContainerType?.[containerTypeKey];
  const assignedRuleSetIds = Array.isArray(assignedRuleSetId)
    ? assignedRuleSetId
    : [assignedRuleSetId].filter(Boolean);
  return (
    ruleSets.find((ruleSet) => ruleSet.id === assignedRuleSetIds[0]) ||
    ruleSets.find((ruleSet) => ruleSet.sourceContainerKey === containerTypeKey) ||
    ruleSets[0]
  );
}

function getLineContainerAssignmentKey(lineId, containerTypeKey) {
  return `${lineId}::${containerTypeKey}`;
}

function getAssignedStorageRuleSetId(terminal, shippingLineId, containerTypeKey) {
  return (
    terminal.storageAssignmentsByLineContainer?.[shippingLineId]?.[
      containerTypeKey
    ] || terminal.storageAssignmentsByContainerType?.[containerTypeKey]
  );
}

function syncTerminalStorageRulesByContainer(
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

      const assignedValue = lineAssignments[line.id]?.[type.key];
      const assignedRuleSetId = Array.isArray(assignedValue)
        ? assignedValue[0]
        : assignedValue;
      let ruleSetId = validRuleSetIds.has(assignedRuleSetId)
        ? assignedRuleSetId
        : null;

      if (!ruleSetId) {
        const containerValue = containerAssignments[type.key];
        const containerRuleSetId = Array.isArray(containerValue)
          ? containerValue[0]
          : containerValue;
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
      getAssignedStorageRuleSetId(terminal, firstLineId, type.key);
    const ruleSet =
      ruleSets.find((entry) => entry.id === ruleSetId) || ruleSets[0];
    terminal.storageAssignmentsByContainerType[type.key] = ruleSet.id;
    terminal.storageRulesByContainer[type.key] = structuredClone(
      ruleSet.rules || []
    );
  }
}

function buildCustomsTerminalDraft(moduleData, portEntry, t) {
  const index = (portEntry.terminals || []).length + 1;
  const id = buildRuleId(`${portEntry.id}-terminal`);
  const currency = moduleData.settings?.defaultQuoteCurrency || "MXN";
  const terminal = {
    id,
    name: t("customs.newTerminalName", { count: index }),
    note: null,
    fixedCharges: [
      {
        id: `${id}-fixed`,
        concept: t("customs.defaultTerminalFixedCharge"),
        note: null,
        taxRate: 0,
        groupRates: buildZeroRatesByContainer(moduleData.containerTypes, currency),
        // O3: per-charge config defaults (kept in lockstep with normalizeCustomsCharge).
        basis: "per_occurrence",
        required: false,
        amount: null,
        amountCurrency: "MXN",
      },
    ],
    storageRulesByContainer: buildDefaultCustomsStorageRules(
      moduleData.containerTypes,
      `${id}-storage`,
      currency
    ),
  };
  const storageRuleSet = buildCustomsStorageRuleSetDraft(moduleData, terminal, t);
  terminal.storageRuleSets = [storageRuleSet];
  terminal.storageAssignmentsByContainerType = Object.fromEntries(
    (moduleData.containerTypes || []).map((type) => [type.key, storageRuleSet.id])
  );
  terminal.storageAssignmentsByLineContainer = Object.fromEntries(
    (moduleData.shippingLines || []).map((line) => [
      line.id,
      Object.fromEntries(
        (moduleData.containerTypes || []).map((type) => [
          type.key,
          storageRuleSet.id,
        ])
      ),
    ])
  );
  terminal.storageUnassignedLineContainers = [];
  syncTerminalStorageRulesByContainer(
    terminal,
    moduleData.shippingLines,
    moduleData.containerTypes
  );

  return terminal;
}

function buildCustomsPortDraft(moduleData, t) {
  const index = (moduleData.ports || []).length + 1;
  const id = buildRuleId("customs-port");
  const port = {
    id,
    name: t("customs.newPortName", { count: index }),
    note: null,
    terminals: [],
  };
  port.terminals = [buildCustomsTerminalDraft(moduleData, port, t)];
  return port;
}

// Count non-zero customs rates keyed by a container type. Used to warn before
// deleting a container type from the master (handover rates are keyed by rate
// group, not by container type, so only customs holds per-container references).
function countCustomsContainerReferences(customsData, key) {
  let count = 0;
  const scanCharges = (charges) => {
    for (const charge of charges || []) {
      const rate = charge.groupRates?.[key];
      if (rate && Number(rate.rate) > 0) {
        count += 1;
      }
    }
  };
  for (const port of customsData?.ports || []) {
    for (const terminal of port.terminals || []) {
      scanCharges(terminal.fixedCharges);
    }
  }
  for (const yard of customsData?.yards || []) {
    scanCharges(yard.dropoffCharges);
    scanCharges(yard.customsCharges);
  }
  return count;
}

function buildCustomsYardDraft(moduleData, t) {
  const index = (moduleData.yards || []).length + 1;
  const id = buildRuleId("customs-yard");
  const currency = moduleData.settings?.defaultQuoteCurrency || "MXN";

  return {
    id,
    name: t("customs.newYardName", { count: index }),
    note: null,
    portIds: moduleData.ports?.[0]?.id ? [moduleData.ports[0].id] : [],
    shippingLineIds: [],
    dropoffCharges: [
      {
        id: `${id}-dropoff`,
        concept: t("customs.defaultDropoffCharge"),
        note: null,
        taxRate: 0,
        groupRates: buildZeroRatesByContainer(moduleData.containerTypes, currency),
      },
    ],
    customsCharges: [
      {
        id: `${id}-customs`,
        concept: t("customs.defaultCustomsYardCharge"),
        note: null,
        taxRate: 0,
        groupRates: buildZeroRatesByContainer(moduleData.containerTypes, currency),
      },
    ],
  };
}

function parsePercentRatio(value, fallback = 0) {
  return Math.min(1, Math.max(0, parseNumber(value, fallback * 100) / 100));
}

function formatPercentValue(ratio) {
  const percent = Math.round(parseNumber(ratio, 0) * 10000) / 100;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(2);
}

function formatTerminalMixSummary(entries = [], t) {
  if (!entries.length) {
    return t("calculator.noTerminalMix");
  }

  const byPort = new Map();
  for (const entry of entries) {
    const port = entry.port || "MANZANILLO";
    if (!byPort.has(port)) {
      byPort.set(port, []);
    }
    byPort.get(port).push(`${entry.terminal} ${formatPercentValue(entry.ratio)}%`);
  }

  return [...byPort.entries()]
    .map(([port, terminals]) => `${port}: ${terminals.join(" / ")}`)
    .join(" | ");
}

function buildTerminalMixDraft(line, t) {
  const existing = line.terminalMix || [];
  return {
    id: buildRuleId(`terminal-mix-${line.id}`),
    port: existing[0]?.port || "MANZANILLO",
    terminal: t("admin.newTerminalMixTerminal"),
    ratio: 0,
  };
}

function getModuleData(shippingData, moduleKey) {
  const normalizedModuleKey = normalizeModuleKey(moduleKey);
  return (
    shippingData.modules?.[normalizedModuleKey] ||
    shippingData.modules?.[DEFAULT_MODULE_KEY]
  );
}

function buildTaxOverrides(body) {
  const keys = ensureArray(body.taxOverrideKey);
  const values = ensureArray(body.taxOverrideRate);
  const taxOverrides = {};

  keys.forEach((key, index) => {
    if (!key) {
      return;
    }
    taxOverrides[key] = values[index] || "default";
  });

  return taxOverrides;
}

function buildDefaultContainerRows(typeList) {
  return [
    {
      containerGroupKey: typeList?.[0]?.key || "",
      quantity: 1,
    },
  ];
}

function buildHandoverFormData(selectedLine, body, settings, containerTypes = []) {
  const groupKeys = ensureArray(body.containerGroupKey);
  const quantities = ensureArray(body.containerCount);
  const containerRows = groupKeys.map((groupKey, index) => ({
    containerGroupKey: groupKey,
    quantity: parseWholeNumber(quantities[index], 0),
  }));

  return {
    shippingLineId: body.shippingLineId || selectedLine?.id || "",
    blCount: parseWholeNumber(body.blCount, 1),
    demurrageDays: parseWholeNumber(body.demurrageDays, 0),
    priceMode: body.priceMode || settings.defaultPriceMode,
    quoteCurrency: body.quoteCurrency || settings.defaultQuoteCurrency,
    businessNature: normalizeBusinessNature(
      body.businessNature,
      "handover_only"
    ),
    taxOverrides: buildTaxOverrides(body),
    containerRows: containerRows.length
      ? containerRows
      : buildDefaultContainerRows(containerTypes),
  };
}

function buildTaxRatePresets(body) {
  const ids = ensureArray(body.taxPresetId);
  const labels = ensureArray(body.taxPresetLabel);
  const rates = ensureArray(body.taxPresetRate);

  return ids
    .map((id, index) => ({
      id: id || `tax-rate-${index + 1}`,
      label: labels[index] || "",
      rate: parseNumber(rates[index], NaN),
    }))
    .filter((preset) => preset.label && Number.isFinite(preset.rate));
}

async function loadShippingData(options = {}) {
  let shippingData = await getShippingData();
  const shouldRefreshRates =
    process.env.SKIP_FX_REFRESH === "1" ? false : options.refreshRates !== false;

  if (shouldRefreshRates) {
    const refreshed = await refreshExchangeRatesIfStale(shippingData, {
      force: options.forceRefreshRates,
    });
    if (refreshed.changed) {
      await saveShippingData(refreshed.data);
      shippingData = refreshed.data;
    }
  }
  return shippingData;
}

function applyRateCellUpdates(rateConfig, body, prefix) {
  if (!rateConfig) {
    return;
  }
  rateConfig.rate = parseNumber(body[`${prefix}_rate`], rateConfig.rate);
  rateConfig.currency = body[`${prefix}_currency`] || rateConfig.currency;
}

// H2/H3 (20260617): the admin rate cells now always render an editable input,
// even when no rate object exists yet. This upsert creates the rate object when
// a value is submitted into a previously-empty cell, updates it when present,
// and clears it (null) when the cell is blanked. `container[key]` is the rate
// slot (e.g. charge.blRate, charge.groupRates[groupKey], guarantee.ratesByGroup[groupKey]).
function upsertRateCell(container, key, body, prefix) {
  if (!container) {
    return;
  }
  const rawRate = body[`${prefix}_rate`];
  const hasValue = rawRate !== undefined && String(rawRate).trim() !== "";
  if (!hasValue) {
    if (container[key]) {
      container[key] = null;
    }
    return;
  }
  const existing =
    container[key] && typeof container[key] === "object" ? container[key] : {};
  container[key] = {
    ...existing,
    rate: parseNumber(rawRate, 0),
    currency: body[`${prefix}_currency`] || existing.currency || "MXN",
  };
}

function buildModuleLinks(language) {
  return getModulePresentations(language).map((module) => ({
    ...module,
    salesHref: `/workbench/${module.key}`,
    adminSettingsHref: `/admin/${module.key}/settings`,
    adminShippingLinesHref: `/admin/${module.key}/shipping-lines`,
  }));
}

function getSafeReturnTo(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value.startsWith("/")) {
    return `/workbench/${DEFAULT_MODULE_KEY}`;
  }
  return value;
}

function baseView(req, overrides = {}) {
  const currentModuleKey = overrides.currentModuleKey || null;
  const currentModule = currentModuleKey
    ? getModulePresentation(currentModuleKey, req.language)
    : null;

  return {
    currentPath: req.path,
    currentArea: overrides.currentArea || null,
    currentModuleKey,
    currentModule,
    currentAdminSection: overrides.currentAdminSection || null,
    user: req.session.user || null,
    userRoleLabel: req.session.user ? req.t(`roles.${req.session.user.role}`) : null,
    flash: req.flash || req.session.flash || null,
    lang: req.language,
    t: req.t,
    languageOptions: getLanguageOptions(req.language),
    languageReturnTo: overrides.languageReturnTo || req.originalUrl || "/",
    modules: buildModuleLinks(req.language),
    pageTitle: overrides.pageTitle || req.t("app.name"),
    ...overrides,
  };
}

function getSelectedLine(moduleData, selectedId) {
  const shippingLines = moduleData.shippingLines || [];
  return (
    shippingLines.find((entry) => entry.id === selectedId) ||
    shippingLines[0] ||
    null
  );
}

function buildDefaultHandoverFormData(moduleData, selectedLine, linkedContext = null) {
  return {
    shippingLineId: linkedContext?.shippingLineId || selectedLine?.id || "",
    blCount: 1,
    demurrageDays: linkedContext?.demurrageDays || 0,
    priceMode: linkedContext?.priceMode || moduleData.settings.defaultPriceMode,
    quoteCurrency:
      linkedContext?.quoteCurrency || moduleData.settings.defaultQuoteCurrency,
    businessNature: linkedContext?.businessNature || "handover_only",
    taxOverrides: linkedContext?.taxOverrides || {},
    containerRows:
      linkedContext?.containerRows?.length
        ? linkedContext.containerRows
        : buildDefaultContainerRows(moduleData.containerTypes),
  };
}

function resolveCustomsSelections(moduleData, partialFormData = {}) {
  const shippingLine =
    moduleData.shippingLines.find(
      (line) => line.id === partialFormData.shippingLineId
    ) ||
    moduleData.shippingLines[0] ||
    null;
  const port =
    moduleData.ports.find((entry) => entry.id === partialFormData.portId) ||
    moduleData.ports[0] ||
    null;
  const terminal =
    port?.terminals.find((entry) => entry.id === partialFormData.terminalId) ||
    port?.terminals[0] ||
    null;
  const availableYards = (moduleData.yards || []).filter(
    (yard) =>
      (!port || yard.portIds.includes(port.id)) &&
      (!shippingLine || yard.shippingLineIds.includes(shippingLine.id))
  );
  const yard =
    availableYards.find((entry) => entry.id === partialFormData.yardId) ||
    availableYards[0] ||
    null;

  return {
    shippingLine,
    port,
    terminal,
    availableYards,
    yard,
  };
}

function buildDefaultCustomsFormData(moduleData, linkedContext = null) {
  const defaults = resolveCustomsSelections(moduleData, linkedContext || {});
  return {
    shippingLineId: defaults.shippingLine?.id || "",
    portId: defaults.port?.id || "",
    terminalId: defaults.terminal?.id || "",
    yardId: defaults.yard?.id || "",
    storageDays: linkedContext?.storageDays || 0,
    priceMode: linkedContext?.priceMode || moduleData.settings.defaultPriceMode,
    quoteCurrency:
      linkedContext?.quoteCurrency || moduleData.settings.defaultQuoteCurrency,
    businessNature: linkedContext?.businessNature || "customs_only",
    taxOverrides: linkedContext?.taxOverrides || {},
    containerRows:
      linkedContext?.containerRows?.length
        ? linkedContext.containerRows
        : buildDefaultContainerRows(moduleData.containerTypes),
  };
}

function buildCustomsFormData(moduleData, body, linkedContext = null) {
  const groupKeys = ensureArray(body.containerGroupKey);
  const quantities = ensureArray(body.containerCount);
  const containerRows = groupKeys.map((groupKey, index) => ({
    containerGroupKey: groupKey,
    quantity: parseWholeNumber(quantities[index], 0),
  }));

  const preliminary = {
    shippingLineId:
      body.shippingLineId || linkedContext?.shippingLineId || moduleData.shippingLines?.[0]?.id || "",
    portId: body.portId || linkedContext?.portId || moduleData.ports?.[0]?.id || "",
    terminalId: body.terminalId || linkedContext?.terminalId || "",
    yardId: body.yardId || linkedContext?.yardId || "",
  };
  const selections = resolveCustomsSelections(moduleData, preliminary);

  return {
    shippingLineId: selections.shippingLine?.id || "",
    portId: selections.port?.id || "",
    terminalId:
      body.terminalId && selections.port?.terminals.some((terminal) => terminal.id === body.terminalId)
        ? body.terminalId
        : selections.terminal?.id || "",
    yardId:
      body.yardId && selections.availableYards.some((yard) => yard.id === body.yardId)
        ? body.yardId
        : selections.yard?.id || "",
    storageDays: parseWholeNumber(body.storageDays, linkedContext?.storageDays || 0),
    priceMode: body.priceMode || moduleData.settings.defaultPriceMode,
    quoteCurrency: body.quoteCurrency || moduleData.settings.defaultQuoteCurrency,
    businessNature: normalizeBusinessNature(
      body.businessNature,
      linkedContext?.businessNature || "customs_only"
    ),
    taxOverrides: buildTaxOverrides(body),
    containerRows: containerRows.length
      ? containerRows
      : buildDefaultContainerRows(moduleData.containerTypes),
  };
}

function rememberCalculatorState(req, moduleKey, formData) {
  const snapshots = req.session.lastCalculatorForms || {};
  snapshots[moduleKey] = formData;
  req.session.lastCalculatorForms = snapshots;
}

function rememberLinkedWorkflow(req, context = {}) {
  req.session.linkedWorkflow = {
    ...req.session.linkedWorkflow,
    ...context,
  };
}

function buildBusinessNatureOptions(moduleKey, t) {
  const allowedValues =
    moduleKey === "handover"
      ? ["handover_only", "handover_customs"]
      : moduleKey === "customs"
        ? ["customs_only", "handover_customs"]
        : ["customs_only"];

  return getLocalizedOptions(BUSINESS_NATURE_OPTIONS, t).filter((option) =>
    allowedValues.includes(option.value)
  );
}

function buildTaxOverrideOptions(moduleData, t) {
  return [
    { value: "default", label: t("tax.defaultOption") },
    ...(moduleData.taxRatePresets || []).map((preset) => ({
      value: String(preset.rate),
      label: preset.label,
    })),
  ];
}

function buildHandoverTaxControls(selectedLine, t) {
  if (!selectedLine) {
    return [];
  }

  const controls = (selectedLine.localCharges || []).map((charge) => ({
    key: `handover:charge:${charge.id}`,
    label: charge.concept,
    defaultLabel: getTaxRateLabel(charge.taxRate),
  }));

  controls.push({
    key: "handover:guarantee",
    label: t("calculator.guaranteeName"),
    defaultLabel: getTaxRateLabel(selectedLine.guarantee?.taxRate || 0),
  });

  controls.push({
    key: "handover:demurrage",
    label: t("categories.demurrage"),
    defaultLabel: getTaxRateLabel(
      selectedLine.demurrage?.ruleSets?.[0]?.rules?.[0]?.taxRate ||
        selectedLine.demurrage?.rulesByGroup?.[selectedLine.containerGroups?.[0]?.key]?.[0]?.taxRate ||
        0
    ),
  });

  return controls;
}

function buildCustomsTaxControls(customsContext, t) {
  const controls = [];

  for (const charge of customsContext.terminal?.fixedCharges || []) {
    controls.push({
      key: `customs:fixed:${charge.id}`,
      label: `${t("customs.categories.terminalFixed")} · ${charge.concept}`,
      defaultLabel: getTaxRateLabel(charge.taxRate),
    });
  }

  controls.push({
    key: "customs:storage",
    label: t("customs.categories.terminalStorage"),
    defaultLabel: getTaxRateLabel(
      customsContext.terminal?.storageRulesByContainer?.[
        customsContext.moduleData?.containerTypes?.[0]?.key
      ]?.[0]?.taxRate || 0
    ),
  });

  for (const charge of customsContext.yard?.dropoffCharges || []) {
    controls.push({
      key: `customs:dropoff:${charge.id}`,
      label: `${t("customs.categories.yardDropoff")} · ${charge.concept}`,
      defaultLabel: getTaxRateLabel(charge.taxRate),
    });
  }

  for (const charge of customsContext.yard?.customsCharges || []) {
    controls.push({
      key: `customs:yard:${charge.id}`,
      label: `${t("customs.categories.yardCustoms")} · ${charge.concept}`,
      defaultLabel: getTaxRateLabel(charge.taxRate),
    });
  }

  return controls;
}

function buildHandoverDependencyData(moduleData, t) {
  return {
    labels: {
      invoiceLockedYes: t("calculator.metadataInvoiceLockedYes"),
      invoiceLockedNo: t("calculator.metadataInvoiceLockedNo"),
      guaranteeOn: t("calculator.metadataGuaranteeOn"),
      guaranteeOff: t("calculator.metadataGuaranteeOff"),
    },
    taxOverrideOptions: buildTaxOverrideOptions(moduleData, t),
    containerTypes: moduleData.containerTypes || [],
    lines: (moduleData.shippingLines || []).map((line) => ({
      id: line.id,
      name: line.name,
      invoiceNote: line.invoiceNote || "",
      invoiceLabel: line.invoiceToConsigneeOnly
        ? t("calculator.metadataInvoiceLockedYes")
        : t("calculator.metadataInvoiceLockedNo"),
      cutoffLabel: getDemurrageCutoffLabel(line.demurrageCutoffHandledBy, t),
      guaranteeLabel: line.guarantee?.benefitEnabled
        ? t("calculator.metadataGuaranteeOn")
        : t("calculator.metadataGuaranteeOff"),
      terminalMixLabel: formatTerminalMixSummary(line.terminalMix || [], t),
      taxControls: buildHandoverTaxControls(line, t),
    })),
  };
}

function buildCustomsDependencyData(moduleData, t) {
  const firstContainerKey = moduleData.containerTypes?.[0]?.key || "";
  const compactCharge = (charge) => ({
    id: charge.id,
    concept: charge.concept,
    taxRate: charge.taxRate,
  });

  return {
    labels: {
      noYardsAvailable: t("customs.noYardsAvailable"),
      notConfigured: t("common.notConfigured"),
      terminalFixed: t("customs.categories.terminalFixed"),
      terminalStorage: t("customs.categories.terminalStorage"),
      yardDropoff: t("customs.categories.yardDropoff"),
      yardCustoms: t("customs.categories.yardCustoms"),
    },
    taxOverrideOptions: buildTaxOverrideOptions(moduleData, t),
    ports: (moduleData.ports || []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      terminals: (entry.terminals || []).map((terminal) => ({
        id: terminal.id,
        name: terminal.name,
        fixedCharges: (terminal.fixedCharges || []).map(compactCharge),
        storageTaxRate:
          terminal.storageRulesByContainer?.[firstContainerKey]?.[0]?.taxRate ||
          0,
      })),
    })),
    yards: (moduleData.yards || []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      portIds: entry.portIds || [],
      shippingLineIds: entry.shippingLineIds || [],
      dropoffCharges: (entry.dropoffCharges || []).map(compactCharge),
      customsCharges: (entry.customsCharges || []).map(compactCharge),
    })),
  };
}

function renderHandoverWorkbench(req, res, payload) {
  const moduleMeta = getModulePresentation(payload.moduleKey, req.language);
  const taxControls = buildHandoverTaxControls(payload.selectedLine, req.t);

  res.render(
    "workbench",
    baseView(req, {
      pageTitle: `${moduleMeta.title} | ${req.t("app.name")}`,
      currentArea: "sales",
      currentModuleKey: payload.moduleKey,
      selectedModule: moduleMeta,
      moduleData: payload.moduleData,
      shippingLines: payload.moduleData.shippingLines || [],
      selectedLine: payload.selectedLine || null,
      selectedLineTerminalMixLabel: formatTerminalMixSummary(
        payload.selectedLine?.terminalMix || [],
        req.t
      ),
      result: payload.result || null,
      formData: payload.formData || null,
      priceModeOptions: getLocalizedOptions(PRICE_MODE_OPTIONS, req.t),
      currencyOptions: CURRENCY_OPTIONS,
      businessNatureOptions: buildBusinessNatureOptions(payload.moduleKey, req.t),
      taxOverrideOptions: buildTaxOverrideOptions(payload.moduleData, req.t),
      taxControls,
      dependencyData: buildHandoverDependencyData(payload.moduleData, req.t),
      canContinueToCustoms:
        payload.result?.businessNature === "handover_customs",
      languageReturnTo: `/workbench/${payload.moduleKey}?restoreLast=1`,
    })
  );
}

function renderCustomsWorkbench(req, res, payload) {
  const moduleMeta = getModulePresentation(payload.moduleKey, req.language);
  const customsContext = {
    moduleData: payload.moduleData,
    shippingLine: payload.customsSelections.shippingLine,
    port: payload.customsSelections.port,
    terminal: payload.customsSelections.terminal,
    yard: payload.customsSelections.yard,
  };

  res.render(
    "workbench-customs",
    baseView(req, {
      pageTitle: `${moduleMeta.title} | ${req.t("app.name")}`,
      currentArea: "sales",
      currentModuleKey: payload.moduleKey,
      selectedModule: moduleMeta,
      moduleData: payload.moduleData,
      formData: payload.formData,
      result: payload.result || null,
      customsSelections: payload.customsSelections,
      priceModeOptions: getLocalizedOptions(PRICE_MODE_OPTIONS, req.t),
      currencyOptions: CURRENCY_OPTIONS,
      businessNatureOptions: buildBusinessNatureOptions(payload.moduleKey, req.t),
      taxOverrideOptions: buildTaxOverrideOptions(payload.moduleData, req.t),
      taxControls: buildCustomsTaxControls(customsContext, req.t),
      dependencyData: buildCustomsDependencyData(payload.moduleData, req.t),
      linkedHandoverContext: payload.linkedHandoverContext || null,
      languageReturnTo: `/workbench/${payload.moduleKey}?restoreLast=1`,
    })
  );
}

function buildDefaultInlandFormData(moduleData, destQuery) {
  const destinations = moduleData.destinations || [];
  const requested = destinations.find((dest) => dest.id === destQuery && dest.enabled);
  return {
    destinationId: requested ? requested.id : "",
    serviceType: "sencillo",
    quantity: 1,
    priceMode: moduleData.settings?.defaultPriceMode || "pretax",
    taxRateOverride: "default",
    precisePointId: "",
    includeBurreo: false,
  };
}

function buildInlandFormData(moduleData, body = {}) {
  return {
    destinationId: String(body.destinationId || "").trim(),
    serviceType: normalizeVehicleType(body.serviceType),
    quantity: parseWholeNumber(body.quantity, 1),
    priceMode: body.priceMode || moduleData.settings?.defaultPriceMode || "pretax",
    taxRateOverride: body.taxRateOverride || "default",
    precisePointId: String(body.precisePointId || "").trim(),
    includeBurreo: body.includeBurreo === "1" || body.includeBurreo === "true" || body.includeBurreo === true,
  };
}

// Compact map + quote payload for the front-end (client-side instant quoting).
// O5: data is scoped to the ACTIVE origin — rates/routes for other origins are
// filtered out so "rate follows origin" holds. A new (empty-shell) origin yields
// no rates yet. activeOriginId defaults to the first origin (Manzanillo seed).
function buildInlandMapData(moduleData, lang = "zh", activeOriginId = null) {
  const origins = moduleData.origins || [];
  const origin =
    origins.find((o) => o.id === activeOriginId) || origins[0] || null;
  const originId = origin ? origin.id : null;
  const entriesByDest = new Map();
  for (const entry of moduleData.rateEntries || []) {
    if (!entry.enabled) {
      continue;
    }
    if (originId && entry.originId && entry.originId !== originId) {
      continue;
    }
    if (!entriesByDest.has(entry.destinationId)) {
      entriesByDest.set(entry.destinationId, []);
    }
    entriesByDest.get(entry.destinationId).push(entry);
  }

  const pickMax = (entries, key) => {
    let best = null;
    for (const entry of entries) {
      const value = entry[key];
      if (value === null || value === undefined) {
        continue;
      }
      if (!best || Number(value) > Number(best[key])) {
        best = entry;
      }
    }
    return best;
  };

  // Highest burreo[service] across a destination's entries (null when none).
  const pickMaxBurreo = (entries, service) => {
    let best = null;
    for (const entry of entries) {
      const value = entry.burreo && entry.burreo[service];
      if (value === null || value === undefined) {
        continue;
      }
      if (best === null || Number(value) > best) {
        best = Number(value);
      }
    }
    return best;
  };

  // S2: highest price per vehicle tier across a destination's entries
  // ({ rate, provider } or null). sencillo/full read legacy fields; the rest read
  // vehiclePrices — all via getVehiclePrice.
  const pickMaxByVehicle = (entries) => {
    const out = {};
    for (const type of VEHICLE_TYPE_KEYS) {
      let best = null;
      for (const entry of entries) {
        const value = getVehiclePrice(entry, type);
        if (value === null || value === undefined) {
          continue;
        }
        if (best === null || Number(value) > Number(best.rate)) {
          best = { rate: Number(value), provider: entry.proveedor };
        }
      }
      out[type] = best;
    }
    return out;
  };

  const destinations = (moduleData.destinations || []).map((dest) => {
    const entries = entriesByDest.get(dest.id) || [];
    const maxSencillo = pickMax(entries, "sencillo");
    const maxFull = pickMax(entries, "full");
    return {
      id: dest.id,
      name: localizedInlandName(dest, lang),
      state: dest.state,
      lat: dest.lat,
      lng: dest.lng,
      enabled: dest.enabled,
      needsReview: dest.needsReview,
      entryCount: entries.length,
      maxSencillo: maxSencillo ? Number(maxSencillo.sencillo) : null,
      maxSencilloProvider: maxSencillo ? maxSencillo.proveedor : null,
      maxFull: maxFull ? Number(maxFull.full) : null,
      maxFullProvider: maxFull ? maxFull.proveedor : null,
      maxBurreoSencillo: pickMaxBurreo(entries, "sencillo"),
      maxBurreoFull: pickMaxBurreo(entries, "full"),
      maxByVehicle: pickMaxByVehicle(entries),
      imageUrls: Array.isArray(dest.imageUrls) ? dest.imageUrls : [],
      precisePoints: (dest.precisePoints || []).map((point) => ({
        id: point.id,
        name: localizedInlandName(point, lang),
        lat: point.lat,
        lng: point.lng,
        flatPrice: point.flatPrice == null ? null : Number(point.flatPrice),
      })),
      entries: entries.map((entry) => ({
        proveedor: entry.proveedor,
        sencillo: entry.sencillo,
        full: entry.full,
        cliente: entry.cliente,
        commodity: entry.commodity,
      })),
    };
  });

  // S4/S5: surface EFFECTIVE values (manual override wins per-field) + source.
  // O5: only routes from the active origin.
  const routes = (moduleData.routeCache || [])
    .filter((rc) => !originId || !rc.originId || rc.originId === originId)
    .map((rc) => {
      const eff = effectiveRoute(rc);
      return {
        destinationId: rc.destinationId,
        targetType: rc.targetType,
        targetId: rc.targetId,
        encodedPolyline: rc.encodedPolyline,
        distanceKm: eff.distanceKm,
        durationMin: eff.durationMin,
        viaCities: eff.viaCities,
        stale: eff.stale,
        hasFerry: eff.hasFerry,
        source: eff.source,
      };
    });

  return {
    origin,
    origins: origins.map((o) => ({ id: o.id, name: o.name, lat: o.lat, lng: o.lng })),
    activeOriginId: originId,
    destinations,
    routes,
  };
}

function renderInlandWorkbench(req, res, payload) {
  const moduleMeta = getModulePresentation(payload.moduleKey, req.language);
  // O5: front-end can route from a chosen origin (?origin=). Defaults to the first.
  const origins = payload.moduleData.origins || [];
  const activeOriginId =
    (origins.find((o) => o.id === req.query.origin) || origins[0] || {}).id || null;
  res.render(
    "workbench-inland",
    baseView(req, {
      pageTitle: `${moduleMeta.title} | ${req.t("app.name")}`,
      currentArea: "sales",
      currentModuleKey: payload.moduleKey,
      selectedModule: moduleMeta,
      moduleData: payload.moduleData,
      formData: payload.formData,
      result: payload.result || null,
      inlandMapData: buildInlandMapData(payload.moduleData, req.language, activeOriginId),
      inlandOrigins: origins,
      activeOriginId,
      vehicleTypeKeys: VEHICLE_TYPE_KEYS,
      priceModeOptions: getLocalizedOptions(PRICE_MODE_OPTIONS, req.t),
      taxRatePresets: payload.moduleData.taxRatePresets || [],
      languageReturnTo: `/workbench/${payload.moduleKey}?restoreLast=1`,
    })
  );
}

function renderWorkbench(req, res, payload) {
  if (payload.moduleKey === "customs") {
    return renderCustomsWorkbench(req, res, payload);
  }
  if (payload.moduleKey === "inland") {
    return renderInlandWorkbench(req, res, payload);
  }
  return renderHandoverWorkbench(req, res, payload);
}

function renderAdminSettings(req, res, payload) {
  const moduleMeta = getModulePresentation(payload.moduleKey, req.language);
  res.render(
    "admin-settings",
    baseView(req, {
      pageTitle: `${req.t("admin.settingsTitle")} | ${moduleMeta.title}`,
      currentArea: "admin",
      currentModuleKey: payload.moduleKey,
      currentAdminSection: "settings",
      selectedModule: moduleMeta,
      moduleData: payload.moduleData,
      exchangeRates: payload.exchangeRates,
      languageReturnTo: req.originalUrl,
      priceModeOptions: getLocalizedOptions(PRICE_MODE_OPTIONS, req.t),
      currencyOptions: CURRENCY_OPTIONS,
      rateGroupNames: RATE_GROUP_NAMES,
    })
  );
}

function renderAdminRules(req, res, payload) {
  const moduleMeta = getModulePresentation(payload.moduleKey, req.language);
  const commonView = {
    pageTitle:
      payload.moduleKey === "customs"
        ? `${req.t("customs.adminTitle")} | ${moduleMeta.title}`
        : `${req.t("admin.shippingLineTitle")} | ${moduleMeta.title}`,
    currentArea: "admin",
    currentModuleKey: payload.moduleKey,
    currentAdminSection: "shipping-lines",
    selectedModule: moduleMeta,
    moduleData: payload.moduleData,
    languageReturnTo: req.originalUrl,
    currencyOptions: CURRENCY_OPTIONS,
  };

  if (payload.moduleKey === "customs") {
    return res.render(
      "admin-customs",
      baseView(req, {
        ...commonView,
        businessModuleRules: payload.moduleData,
      })
    );
  }

  if (payload.moduleKey === "inland") {
    return res.render(
      "admin-inland",
      baseView(req, {
        ...commonView,
        inlandData: payload.moduleData,
      })
    );
  }

  return res.render(
    "admin-module",
    baseView(req, {
      ...commonView,
      shippingLines: payload.moduleData.shippingLines || [],
      selectedLine: payload.selectedLine || null,
      demurrageCutoffOptions: getLocalizedOptions(DEMURRAGE_CUTOFF_OPTIONS, req.t),
    })
  );
}

// Q4/Q5/Q6 (20260617): header fields are now dropdowns over fixed option sets.
// A submitted value outside its set is dropped to "" (no legacy free-text kept)
// — Jose supplied the standard sets, so stray values get normalized away.
function pickFromOptions(value, options, fallback = "") {
  const normalized = String(value ?? "").trim().toUpperCase();
  return options.includes(normalized) ? normalized : fallback;
}

function parseQuoteHeader(body = {}) {
  return {
    operation: body.operation === "EXPORT" ? "EXPORT" : "IMPORT",
    department: pickFromOptions(
      body.department,
      QUOTE_DEPARTMENT_OPTIONS,
      DEFAULT_QUOTE_HEADER.department
    ),
    transportMode: pickFromOptions(
      body.transportMode,
      QUOTE_TRANSPORT_MODE_OPTIONS,
      ""
    ),
    incoterm: pickFromOptions(body.incoterm, QUOTE_INCOTERM_OPTIONS, ""),
    pol: body.pol ?? DEFAULT_QUOTE_HEADER.pol,
    pod: body.pod ?? DEFAULT_QUOTE_HEADER.pod,
    commodity: body.commodity || "",
    cargoType: pickFromOptions(body.cargoType, QUOTE_CARGO_TYPE_OPTIONS, ""),
    delivery: body.delivery || "",
    // Q7.2: ordered, addable/removable custom general-data rows (label/value).
    extraFields: parseQuoteExtraFields(body),
  };
}

// Q7.2: parse the dynamic general-data rows; drop blank-labelled rows.
function parseQuoteExtraFields(body = {}) {
  const labels = ensureArray(body.gd_label);
  const values = ensureArray(body.gd_value);
  return labels
    .map((label, index) => ({
      label: String(label || "").trim(),
      value: String(values[index] ?? "").trim(),
    }))
    .filter((row) => row.label);
}

function parseQuoteLineItems(body = {}) {
  const ids = ensureArray(body.li_id);
  const cell = (name, index) => ensureArray(body[name])[index] ?? "";
  return ids.map((id, index) => {
    const calcModule = cell("li_calcModule", index);
    const calcField = cell("li_calcField", index);
    return {
      id: id || `li-${index + 1}`,
      // Q7.3: section splits MEXICO LOCAL vs NO MEXICO (origin/China side) charges.
      section: cell("li_section", index) === "foreign" ? "foreign" : "mexico",
      category: cell("li_category", index),
      code: cell("li_code", index),
      conceptEn: cell("li_conceptEn", index),
      conceptZh: cell("li_conceptZh", index),
      conceptEs: cell("li_conceptEs", index),
      unit: cell("li_unit", index),
      // Q7.3: unit of measure (柜/提单/次/个/车型/天); `unit` stays the numeric qty.
      unitOfMeasure: cell("li_uom", index),
      unitPrice: cell("li_unitPrice", index),
      currency: cell("li_currency", index),
      remark: cell("li_remark", index),
      isAtCost: String(cell("li_atCost", index)) === "1",
      source: cell("li_source", index) || "manual",
      calcRef: calcModule && calcField ? { module: calcModule, field: calcField } : null,
    };
  });
}

function parseQuotePullInputs(body = {}) {
  return {
    shippingLineId: body.pull_shippingLineId || "",
    portId: body.pull_portId || "",
    terminalId: body.pull_terminalId || "",
    destinationId: body.pull_destinationId || "",
    containerTypeKey: body.pull_containerTypeKey || "",
    quantity: parseWholeNumber(body.pull_quantity, 1) || 1,
    demurrageDays: parseWholeNumber(body.pull_demurrageDays, 0),
    storageDays: parseWholeNumber(body.pull_storageDays, 0),
  };
}

function buildQuoteSelectorData(shippingData) {
  const handover = getModuleData(shippingData, "handover");
  const customs = getModuleData(shippingData, "customs");
  const inland = getModuleData(shippingData, "inland");
  return {
    shippingLines: (handover.shippingLines || []).map((line) => ({
      id: line.id,
      name: line.name,
    })),
    containerTypes: (handover.containerTypes || []).map((type) => ({
      key: type.key,
      label: type.label,
    })),
    ports: (customs.ports || []).map((port) => ({
      id: port.id,
      name: port.name,
      terminals: (port.terminals || []).map((terminal) => ({
        id: terminal.id,
        name: terminal.name,
      })),
    })),
    destinations: (inland.destinations || [])
      .filter((dest) => dest.enabled)
      .map((dest) => ({ id: dest.id, name: dest.name, state: dest.state })),
  };
}

function assembleQuoteView(quoteModule, formData, shippingData) {
  const quoteSettings = quoteModule.settings || {};
  const totals = computeQuoteTotals(formData.lineItems, {
    exchangeRates: shippingData.exchangeRates,
    showIndicativeConversion: quoteSettings.showIndicativeConversion,
    indicativeCurrency: quoteSettings.indicativeCurrency,
    // R4 dual-currency display (default on; MXN sin IVA + USD con 16% IVA).
    dualCurrency: quoteSettings.dualCurrency !== false,
    ivaMxn: Number.isFinite(Number(quoteSettings.ivaMxn)) ? Number(quoteSettings.ivaMxn) : 0,
    ivaUsd: Number.isFinite(Number(quoteSettings.ivaUsd)) ? Number(quoteSettings.ivaUsd) : 0.16,
  });
  const route = resolveQuoteRoute(
    getModuleData(shippingData, "inland"),
    formData.pullInputs?.destinationId
  );
  return {
    number: formData.number,
    date: formData.date,
    header: formData.header,
    rows: totals.rows,
    groups: groupRowsForRender(totals.rows),
    sections: groupRowsBySection(totals.rows),
    subtotals: totals.subtotals,
    indicative: totals.indicative,
    dualTotals: totals.dualTotals,
    route,
    notes: selectQuoteNotes(quoteModule.notes, formData.noteIds),
    language: formData.language || "",
  };
}

// Q11: resolve the ordered subset of remarks to print. When no selection is
// recorded, print the whole library (back-compat with quotes/drafts pre-Q11).
function selectQuoteNotes(library = [], selectedIds) {
  if (!Array.isArray(selectedIds)) {
    return library;
  }
  const byId = new Map(library.map((n) => [n.id, n]));
  const picked = selectedIds.map((id) => byId.get(id)).filter(Boolean);
  return picked.length ? picked : (selectedIds.length ? [] : library);
}

function buildQuoteFormData(quoteModule, body = {}, options = {}) {
  const hasPostedRows = ensureArray(body.li_id).length > 0;
  const lineItems = hasPostedRows ? parseQuoteLineItems(body) : buildInitialLineItems();
  const number =
    (body.quotationNumber || "").trim() || generateQuoteNumber(quoteModule.settings).number;
  const today = new Date().toISOString().slice(0, 10);
  // Q11: ordered subset of remark-library ids to print. A fresh quote (nothing
  // posted) defaults to ALL remarks selected.
  const libraryIds = (quoteModule.notes || []).map((n) => n.id);
  const postedNoteIds = ensureArray(body.note_sel).map(String);
  const language = pickFromOptions(body.quoteLang, ["EN", "ZH", "ES"], "");
  return {
    number,
    date: (body.date || "").trim() || options.date || today,
    header: parseQuoteHeader(body),
    lineItems,
    noteIds: hasPostedRows ? postedNoteIds : libraryIds,
    language, // Q7: "" = bilingual EN+中 (legacy); EN/ZH/ES = single language
    pullInputs: parseQuotePullInputs(body),
  };
}

function renderQuoteWorkbench(req, res, payload) {
  const moduleMeta = getModulePresentation(payload.moduleKey, req.language);
  res.render(
    "workbench-quote",
    baseView(req, {
      pageTitle: `${moduleMeta.title} | ${req.t("app.name")}`,
      currentArea: "sales",
      currentModuleKey: payload.moduleKey,
      selectedModule: moduleMeta,
      quoteSettings: payload.quoteModule.settings,
      quoteView: payload.quoteView,
      formData: payload.formData,
      quoteNotes: payload.quoteModule.notes || [],
      selectorData: payload.selectorData,
      feeCodes: payload.feeCodes,
      currencyOptions: CURRENCY_OPTIONS,
      headerOptions: {
        department: QUOTE_DEPARTMENT_OPTIONS,
        transportMode: QUOTE_TRANSPORT_MODE_OPTIONS,
        incoterm: QUOTE_INCOTERM_OPTIONS,
        cargoType: QUOTE_CARGO_TYPE_OPTIONS,
      },
      uomOptions: QUOTE_UOM_OPTIONS,
      languageReturnTo: `/workbench/${payload.moduleKey}`,
    })
  );
}

function createApp() {
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "../views"));

  app.use(
    express.urlencoded({
      extended: true,
      limit: "10mb",
      parameterLimit: 50000,
    })
  );
  app.use(express.static(path.join(__dirname, "../public")));
  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
    })
  );

  app.use((req, _res, next) => {
    const requestedLanguage =
      req.query.lang ||
      req.body?.lang ||
      req.session.language ||
      normalizeLanguage();
    req.language = normalizeLanguage(requestedLanguage);
    req.session.language = req.language;
    req.t = buildTranslator(req.language);
    next();
  });

  app.use((req, _res, next) => {
    req.session.user = req.session.user || publicDemoUser;
    next();
  });

  app.use((req, _res, next) => {
    if (req.session.flash) {
      req.flash = req.session.flash;
      delete req.session.flash;
    }
    next();
  });

  app.get("/", (req, res) => {
    return res.redirect(`/workbench/${DEFAULT_MODULE_KEY}`);
  });

  app.post("/preferences/language", (req, res) => {
    req.session.language = normalizeLanguage(req.body.language, req.language);
    return res.redirect(getSafeReturnTo(req.body.returnTo));
  });

  app.get("/login", (req, res) => {
    return res.redirect(`/workbench/${DEFAULT_MODULE_KEY}`);
  });

  app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    const userData = await getUsers();
    const user = userData.users.find(
      (entry) => entry.username === username && entry.password === password
    );

    if (!user) {
      return res.status(401).render(
        "login",
        baseView(req, {
          pageTitle: req.t("login.title"),
          flash: { type: "error", message: req.t("login.invalid") },
          languageReturnTo: "/login",
        })
      );
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      role: user.role,
      username: user.username,
    };
    return res.redirect(`/workbench/${DEFAULT_MODULE_KEY}`);
  });

  app.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect(`/workbench/${DEFAULT_MODULE_KEY}`);
    });
  });

  app.get("/workbench/:moduleKey", requireAuth, async (req, res) => {
    const module = getBusinessModule(req.params.moduleKey);
    if (!module) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    const shippingData = await loadShippingData();
    const moduleData = getModuleData(shippingData, module.key);
    const restoreLast = req.query.restoreLast === "1";
    const rememberedForm = req.session.lastCalculatorForms?.[module.key];

    if (module.key === "customs") {
      const linkedContext = req.query.useLinked === "1"
        ? req.session.linkedWorkflow?.customs || null
        : null;
      const formData = restoreLast && rememberedForm
        ? buildCustomsFormData(moduleData, rememberedForm, linkedContext)
        : buildDefaultCustomsFormData(moduleData, linkedContext);
      const customsSelections = resolveCustomsSelections(moduleData, formData);
      const result = restoreLast && rememberedForm
        ? computeCustomsCalculator(
            moduleData,
            formData,
            {
              exchangeRates: shippingData.exchangeRates,
            },
            { t: req.t }
          )
        : null;

      return renderWorkbench(req, res, {
        moduleKey: module.key,
        moduleData,
        formData,
        result,
        customsSelections,
        linkedHandoverContext: linkedContext,
      });
    }

    if (module.key === "inland") {
      const formData =
        restoreLast && rememberedForm
          ? buildInlandFormData(moduleData, rememberedForm)
          : buildDefaultInlandFormData(moduleData, req.query.dest);
      const result = formData.destinationId
        ? computeInlandCalculator(moduleData, formData, { t: req.t })
        : null;
      return renderWorkbench(req, res, {
        moduleKey: module.key,
        moduleData,
        formData,
        result,
      });
    }

    if (module.key === "quote") {
      const quoteModule = moduleData;
      const formData = buildQuoteFormData(quoteModule, {});
      return renderQuoteWorkbench(req, res, {
        moduleKey: module.key,
        quoteModule,
        formData,
        quoteView: assembleQuoteView(quoteModule, formData, shippingData),
        selectorData: buildQuoteSelectorData(shippingData),
        feeCodes: loadFeeCodes(),
      });
    }

    if (!module.implemented || !moduleData.shippingLines.length) {
      return renderWorkbench(req, res, {
        moduleKey: module.key,
        moduleData,
        selectedLine: null,
        result: null,
        formData: buildDefaultHandoverFormData(moduleData, null),
      });
    }

    let selectedLine = getSelectedLine(
      moduleData,
      req.query.shippingLineId || rememberedForm?.shippingLineId
    );
    let formData = buildDefaultHandoverFormData(moduleData, selectedLine);
    let result = null;

    if (restoreLast && rememberedForm) {
      selectedLine = getSelectedLine(moduleData, rememberedForm.shippingLineId);
      formData = buildHandoverFormData(
        selectedLine,
        rememberedForm,
        moduleData.settings,
        moduleData.containerTypes
      );
      result = computeCalculator(
        selectedLine,
        formData,
        {
          exchangeRates: shippingData.exchangeRates,
          settings: moduleData.settings,
          containerTypes: moduleData.containerTypes,
        },
        { t: req.t }
      );
    }

    return renderWorkbench(req, res, {
      moduleKey: module.key,
      moduleData,
      selectedLine,
      result,
      formData,
    });
  });

  app.post("/workbench/handover", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData();
    const moduleData = getModuleData(shippingData, "handover");
    const selectedLine = getSelectedLine(moduleData, req.body.shippingLineId);

    if (!selectedLine) {
      res.status(400);
      return renderWorkbench(req, res, {
        moduleKey: "handover",
        moduleData,
        selectedLine: null,
        result: null,
        formData: buildDefaultHandoverFormData(moduleData, null),
      });
    }

    const formData = buildHandoverFormData(
      selectedLine,
      req.body,
      moduleData.settings,
      moduleData.containerTypes
    );
    const result = computeCalculator(
      selectedLine,
      formData,
      {
        exchangeRates: shippingData.exchangeRates,
        settings: moduleData.settings,
        containerTypes: moduleData.containerTypes,
      },
      { t: req.t }
    );

    rememberCalculatorState(req, "handover", formData);
    if (formData.businessNature === "handover_customs") {
      rememberLinkedWorkflow(req, {
        customs: {
          businessNature: "handover_customs",
          shippingLineId: formData.shippingLineId,
          containerRows: formData.containerRows,
          quoteCurrency: formData.quoteCurrency,
          priceMode: formData.priceMode,
        },
      });
    }

    return renderWorkbench(req, res, {
      moduleKey: "handover",
      moduleData,
      selectedLine,
      result,
      formData,
    });
  });

  app.post("/workbench/customs", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData();
    const moduleData = getModuleData(shippingData, "customs");
    const linkedContext = req.session.linkedWorkflow?.customs || null;
    const formData = buildCustomsFormData(moduleData, req.body, linkedContext);
    const customsSelections = resolveCustomsSelections(moduleData, formData);
    const result = computeCustomsCalculator(
      moduleData,
      formData,
      {
        exchangeRates: shippingData.exchangeRates,
      },
      { t: req.t }
    );

    rememberCalculatorState(req, "customs", formData);
    rememberLinkedWorkflow(req, {
      customs: {
        ...linkedContext,
        ...formData,
      },
    });

    return renderWorkbench(req, res, {
      moduleKey: "customs",
      moduleData,
      formData,
      result,
      customsSelections,
      linkedHandoverContext: linkedContext,
    });
  });

  app.post("/workbench/inland", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData();
    const moduleData = getModuleData(shippingData, "inland");
    const formData = buildInlandFormData(moduleData, req.body);
    const result = formData.destinationId
      ? computeInlandCalculator(moduleData, formData, { t: req.t })
      : null;
    rememberCalculatorState(req, "inland", formData);
    return renderWorkbench(req, res, {
      moduleKey: "inland",
      moduleData,
      formData,
      result,
    });
  });

  // --- Inland admin ---
  const INLAND_ADMIN_TARGET = "/admin/inland/shipping-lines";

  app.post("/workbench/quote", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const quoteModule = getModuleData(shippingData, "quote");
    const formData = buildQuoteFormData(quoteModule, req.body);
    const action = req.body.action || "recompute";

    if (action === "pull") {
      formData.lineItems = pullCalculatorValues({
        shippingData,
        inputs: formData.pullInputs,
        lineItems: formData.lineItems,
        calculators: {
          computeHandoverCalculator: computeCalculator,
          computeCustomsCalculator,
          computeInlandCalculator,
        },
        t: req.t,
      });
      const hasData =
        (shippingData.modules.handover?.shippingLines?.length || 0) +
          (shippingData.modules.customs?.ports?.length || 0) +
          (shippingData.modules.inland?.destinations?.length || 0) >
        0;
      req.flash = {
        type: hasData ? "success" : "info",
        message: hasData ? req.t("quote.pulled") : req.t("quote.noShippingData"),
      };
    } else if (action === "saveDraft") {
      const provided = (req.body.quotationNumber || "").trim();
      let advanceTo = null;
      if (provided) {
        formData.number = provided;
      } else {
        const generated = generateQuoteNumber(quoteModule.settings);
        formData.number = generated.number;
        advanceTo = generated.nextSeq;
      }
      const now = new Date().toISOString();
      quoteModule.drafts = [
        ...(quoteModule.drafts || []),
        {
          id: buildRuleId("quote"),
          number: formData.number,
          date: formData.date,
          header: formData.header,
          lineItems: formData.lineItems,
          createdAt: now,
          updatedAt: now,
        },
      ];
      if (advanceTo !== null) {
        quoteModule.settings.lastQuoteSeq = advanceTo;
      }
      await saveShippingData(shippingData);
      req.flash = {
        type: "success",
        message: `${req.t("quote.draftSaved")}${formData.number}`,
      };
    }

    return renderQuoteWorkbench(req, res, {
      moduleKey: "quote",
      quoteModule,
      formData,
      quoteView: assembleQuoteView(quoteModule, formData, shippingData),
      selectorData: buildQuoteSelectorData(shippingData),
      feeCodes: loadFeeCodes(),
    });
  });

  app.post("/workbench/quote/pdf", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const quoteModule = getModuleData(shippingData, "quote");
    const formData = buildQuoteFormData(quoteModule, req.body);

    const provided = (req.body.quotationNumber || "").trim();
    let advanceTo = null;
    if (provided) {
      formData.number = provided;
    } else {
      const generated = generateQuoteNumber(quoteModule.settings);
      formData.number = generated.number;
      advanceTo = generated.nextSeq;
    }

    const quoteView = assembleQuoteView(quoteModule, formData, shippingData);

    try {
      const pdf = await renderQuotePdf(quoteView);

      if (advanceTo !== null) {
        quoteModule.settings.lastQuoteSeq = advanceTo;
        await saveShippingData(shippingData);
      }

      if (shouldUseDatabase()) {
        try {
          await insertQuoteSnapshot({
            moduleKey: "quote",
            businessNature: quoteView.header.operation,
            input: {
              number: formData.number,
              header: formData.header,
              lineItems: formData.lineItems,
            },
            result: {
              rows: quoteView.rows,
              subtotals: quoteView.subtotals,
              indicative: quoteView.indicative,
            },
          });
        } catch (snapshotError) {
          console.error("quote snapshot failed", snapshotError);
        }
      }

      const safeName = String(formData.number || "quote").replace(/[^A-Za-z0-9._-]+/g, "_");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.pdf"`);
      return res.send(pdf);
    } catch (error) {
      console.error("quote pdf generation failed", error);
      return redirectWithFlash(req, res, "error", req.t("quote.pdfError"), "/workbench/quote");
    }
  });

  app.post("/admin/inland/resolve-link", requireAuth, async (req, res) => {
    const result = await resolveLink(req.body.link || "");
    if (result.error) {
      return res.status(422).json({ error: result.error });
    }
    return res.json({
      lat: result.lat,
      lng: result.lng,
      name: result.name,
      normalizedLink: result.normalizedLink,
      warning: result.warning,
    });
  });

  function markRouteStale(inland, destinationId) {
    (inland.routeCache || []).forEach((rc) => {
      if (rc.destinationId === destinationId) {
        rc.stale = true;
      }
    });
  }

  async function refreshOneInlandRoute(inland, origin, target) {
    // S4: route via the configured provider (OSRM default; Google when keyed).
    // via-city snapping stays here so it is provider-agnostic.
    const provider = getRoutingProvider();
    const route = await provider.fetchRoute(origin, { lat: target.lat, lng: target.lng });
    const viaCities = computeViaCities(decodePolyline(route.encodedPolyline));
    const entry = {
      id: `rc-${target.destinationId}-${target.targetType}${target.targetId ? `-${target.targetId}` : ""}`,
      originId: origin.id,
      destinationId: target.destinationId,
      targetType: target.targetType,
      targetId: target.targetId,
      encodedPolyline: route.encodedPolyline,
      distanceKm: route.distanceKm,
      durationMin: route.durationMin,
      viaCities,
      engine: route.engine,
      fetchedAt: new Date().toISOString(),
      stale: false,
      hasFerry: route.hasFerry,
    };
    inland.routeCache = inland.routeCache || [];
    const existing = inland.routeCache.find(
      (rc) =>
        rc.destinationId === target.destinationId &&
        rc.targetType === target.targetType &&
        (rc.targetId || null) === (target.targetId || null)
    );
    if (existing) {
      Object.assign(existing, entry, { id: existing.id });
    } else {
      inland.routeCache.push(entry);
    }
  }

  app.post("/admin/inland/routes/refresh", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const origin = (inland.origins && inland.origins[0]) || null;
    if (!origin) {
      return redirectWithFlash(req, res, "error", req.t("inland.routeRefreshFailed"), INLAND_ADMIN_TARGET);
    }

    const onlyId = String(req.body.destinationId || "").trim();
    const targets = [];
    for (const dest of inland.destinations || []) {
      if (dest.lat == null || dest.lng == null) continue;
      if (onlyId && dest.id !== onlyId) continue;
      const cache = (inland.routeCache || []).find(
        (rc) => rc.destinationId === dest.id && rc.targetType === "destination"
      );
      if (!onlyId && cache && !cache.stale) continue; // "all" only fills missing/stale
      targets.push({ destinationId: dest.id, targetType: "destination", targetId: null, lat: dest.lat, lng: dest.lng });
      for (const point of dest.precisePoints || []) {
        if (point.lat != null && point.lng != null) {
          targets.push({ destinationId: dest.id, targetType: "precisePoint", targetId: point.id, lat: point.lat, lng: point.lng });
        }
      }
    }

    let ok = 0;
    let failed = 0;
    for (const target of targets) {
      try {
        await refreshOneInlandRoute(inland, origin, target);
        ok += 1;
      } catch (_error) {
        failed += 1;
      }
    }
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(
      req,
      res,
      failed ? "error" : "success",
      req.t("inland.routeRefreshed", { ok, failed }),
      INLAND_ADMIN_TARGET
    );
  });

  // S4 manual override: operator-entered km / minutes / via-cities for a route.
  app.post("/admin/inland/routes/:destId/override", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const destId = String(req.params.destId || "").trim();
    const rc = (inland.routeCache || []).find(
      (r) => r.destinationId === destId && r.targetType === "destination"
    );
    if (!rc) {
      return redirectWithFlash(req, res, "error", req.t("inland.routeNone"), `${INLAND_ADMIN_TARGET}#dest-${destId}`);
    }
    const toNum = (v) => {
      const s = String(v ?? "").trim();
      if (!s) return null;
      const n = Number(s.replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    rc.manualOverride = {
      distanceKm: toNum(req.body.ovr_km),
      durationMin: toNum(req.body.ovr_min),
      viaCities: String(req.body.ovr_via || "").split(",").map((s) => s.trim()).filter(Boolean),
    };
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.routeOverrideSaved"), `${INLAND_ADMIN_TARGET}#dest-${destId}`);
  });

  app.post("/admin/inland/routes/:destId/clear-override", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const destId = String(req.params.destId || "").trim();
    const rc = (inland.routeCache || []).find(
      (r) => r.destinationId === destId && r.targetType === "destination"
    );
    if (rc) rc.manualOverride = null;
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.routeOverrideCleared"), `${INLAND_ADMIN_TARGET}#dest-${destId}`);
  });

  // O5 (20260617): admin-managed origins. New origins start with NO rate entries
  // (empty shell). The seed origin (Manzanillo) and its rates are untouched.
  app.post("/admin/inland/origins/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    let name = String(req.body.name || "").trim();
    const link = String(req.body.link || "").trim();
    let lat = req.body.lat ? Number(req.body.lat) : null;
    let lng = req.body.lng ? Number(req.body.lng) : null;
    if (link) {
      const resolved = await resolveLink(link);
      if (resolved.error) {
        return redirectWithFlash(req, res, "error", req.t("inland.linkFailed", { error: resolved.error }), `${INLAND_ADMIN_TARGET}#inland-origins`);
      }
      lat = resolved.lat;
      lng = resolved.lng;
      if (!name && resolved.name) name = resolved.name;
    }
    if (!name) {
      return redirectWithFlash(req, res, "error", req.t("inland.nameRequired"), `${INLAND_ADMIN_TARGET}#inland-origins`);
    }
    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `origin-${Date.now()}`;
    let oid = baseId;
    let oi = 2;
    inland.origins = inland.origins || [];
    while (inland.origins.some((o) => o.id === oid)) {
      oid = `${baseId}-${oi++}`;
    }
    inland.origins.push({ id: oid, name, lat, lng });
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.originAdded", { name }), `${INLAND_ADMIN_TARGET}#inland-origins`);
  });

  app.post("/admin/inland/origins/save", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    for (const origin of inland.origins || []) {
      const name = req.body[`origin_name_${origin.id}`];
      if (name !== undefined) origin.name = String(name).trim() || origin.name;
      const lat = req.body[`origin_lat_${origin.id}`];
      if (lat !== undefined) origin.lat = String(lat).trim() === "" ? null : Number(lat);
      const lng = req.body[`origin_lng_${origin.id}`];
      if (lng !== undefined) origin.lng = String(lng).trim() === "" ? null : Number(lng);
    }
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.originsSaved"), `${INLAND_ADMIN_TARGET}#inland-origins`);
  });

  app.post("/admin/inland/origins/:id/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const origins = inland.origins || [];
    const hasRates = (inland.rateEntries || []).some((r) => r.originId === req.params.id);
    if (origins.length <= 1 || hasRates) {
      // keep at least one origin; never orphan rate entries
      return redirectWithFlash(req, res, "error", req.t("inland.originDeleteBlocked"), `${INLAND_ADMIN_TARGET}#inland-origins`);
    }
    inland.origins = origins.filter((o) => o.id !== req.params.id);
    inland.routeCache = (inland.routeCache || []).filter((rc) => rc.originId !== req.params.id);
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.originDeleted"), `${INLAND_ADMIN_TARGET}#inland-origins`);
  });

  app.post("/admin/inland/destinations/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const name = String(req.body.name || "").trim();
    if (!name) {
      return redirectWithFlash(req, res, "error", req.t("inland.nameRequired"), INLAND_ADMIN_TARGET);
    }
    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `dest-${Date.now()}`;
    let id = baseId;
    let n = 2;
    while ((inland.destinations || []).some((d) => d.id === id)) {
      id = `${baseId}-${n++}`;
    }
    inland.destinations = inland.destinations || [];
    inland.destinations.push({
      id,
      name,
      state: String(req.body.state || "").trim(),
      lat: req.body.lat ? Number(req.body.lat) : null,
      lng: req.body.lng ? Number(req.body.lng) : null,
      coordSource: "manual",
      needsReview: false,
      precisePoints: [],
      enabled: true,
      note: "",
    });
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.destAdded", { name }), `${INLAND_ADMIN_TARGET}#dest-${id}`);
  });

  app.post("/admin/inland/destinations/save", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    for (const dest of inland.destinations || []) {
      if (req.body[`dest_present_${dest.id}`] === undefined) continue;
      const name = req.body[`dest_name_${dest.id}`];
      if (name !== undefined) dest.name = String(name).trim() || dest.name;
      // O6.5: optional bilingual display names.
      const nameZh = req.body[`dest_nameZh_${dest.id}`];
      if (nameZh !== undefined) dest.nameZh = String(nameZh).trim();
      const nameEs = req.body[`dest_nameEs_${dest.id}`];
      if (nameEs !== undefined) dest.nameEs = String(nameEs).trim();
      const state = req.body[`dest_state_${dest.id}`];
      if (state !== undefined) dest.state = String(state).trim();
      const note = req.body[`dest_note_${dest.id}`];
      if (note !== undefined) dest.note = String(note);
      // S3 case photos: store the raw textarea (one URL/line); normalizeShippingData
      // (normalizeImageUrls) on save keeps only http(s), dedupes, caps.
      const images = req.body[`dest_images_${dest.id}`];
      if (images !== undefined) dest.imageUrls = String(images);
      dest.enabled = req.body[`dest_enabled_${dest.id}`] !== undefined;

      const link = String(req.body[`dest_coordlink_${dest.id}`] || "").trim();
      if (link) {
        const resolved = await resolveLink(link);
        if (!resolved.error) {
          dest.lat = resolved.lat;
          dest.lng = resolved.lng;
          dest.coordSource = /^https?:/i.test(link) ? "gmaps-link" : "manual";
          dest.needsReview = false;
          markRouteStale(inland, dest.id);
        }
      } else {
        const lat = req.body[`dest_lat_${dest.id}`];
        const lng = req.body[`dest_lng_${dest.id}`];
        if (lat !== undefined && lng !== undefined && lat !== "" && lng !== "") {
          const nextLat = Number(lat);
          const nextLng = Number(lng);
          if (nextLat !== dest.lat || nextLng !== dest.lng) {
            dest.lat = nextLat;
            dest.lng = nextLng;
            dest.coordSource = "manual";
            markRouteStale(inland, dest.id);
          }
        }
      }
    }
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.saved"), INLAND_ADMIN_TARGET);
  });

  app.post("/admin/inland/destinations/:id/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const dest = (inland.destinations || []).find((d) => d.id === req.params.id);
    if (!dest) {
      return res.status(404).render("not-found", baseView(req, { pageTitle: req.t("system.notFoundTitle"), languageReturnTo: req.originalUrl }));
    }
    inland.destinations = inland.destinations.filter((d) => d.id !== req.params.id);
    inland.rateEntries = (inland.rateEntries || []).filter((e) => e.destinationId !== req.params.id);
    inland.routeCache = (inland.routeCache || []).filter((rc) => rc.destinationId !== req.params.id);
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.destDeleted", { name: dest.name }), INLAND_ADMIN_TARGET);
  });

  app.post("/admin/inland/destinations/:id/precise-points/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const dest = (inland.destinations || []).find((d) => d.id === req.params.id);
    if (!dest) {
      return res.status(404).render("not-found", baseView(req, { pageTitle: req.t("system.notFoundTitle"), languageReturnTo: req.originalUrl }));
    }
    const link = String(req.body.link || "").trim();
    let lat = req.body.lat ? Number(req.body.lat) : null;
    let lng = req.body.lng ? Number(req.body.lng) : null;
    let name = String(req.body.name || "").trim();
    let source = "manual";
    if (link) {
      const resolved = await resolveLink(link);
      if (resolved.error) {
        return redirectWithFlash(req, res, "error", req.t("inland.linkFailed", { error: resolved.error }), `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
      }
      lat = resolved.lat;
      lng = resolved.lng;
      if (!name && resolved.name) name = resolved.name;
      source = /^https?:/i.test(link) ? "gmaps-link" : "manual";
    }
    if (!name) {
      return redirectWithFlash(req, res, "error", req.t("inland.nameRequired"), `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
    }
    dest.precisePoints = dest.precisePoints || [];
    const flatRaw = req.body.flatPrice;
    const newPoint = {
      id: `pp-${dest.id}-${Date.now().toString(36)}`,
      name,
      lat,
      lng,
      // S1: optional flat all-in price (一口价). Empty -> null -> inherit city rate.
      flatPrice: flatRaw !== undefined && String(flatRaw).trim() !== "" ? Number(flatRaw) : null,
      note: String(req.body.note || ""),
      source,
      link: /^https?:/i.test(link) ? link : "",
    };
    dest.precisePoints.push(newPoint);
    // O6.1 (20260617): auto-fetch this precise point's route so the map can draw
    // a line to the exact point immediately (was: only the destination-level route
    // existed until a manual "refresh routes"). Non-fatal — provider failures just
    // leave the route to be filled by a later refresh.
    const origin = (inland.origins && inland.origins[0]) || null;
    if (origin && newPoint.lat != null && newPoint.lng != null) {
      try {
        await refreshOneInlandRoute(inland, origin, {
          destinationId: dest.id,
          targetType: "precisePoint",
          targetId: newPoint.id,
          lat: newPoint.lat,
          lng: newPoint.lng,
        });
      } catch (_error) {
        // leave route uncached; admin can refresh later
      }
    }
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.preciseAdded", { name }), `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
  });

  app.post("/admin/inland/destinations/:id/precise-points/:pointId/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const dest = (inland.destinations || []).find((d) => d.id === req.params.id);
    if (!dest) {
      return res.status(404).render("not-found", baseView(req, { pageTitle: req.t("system.notFoundTitle"), languageReturnTo: req.originalUrl }));
    }
    dest.precisePoints = (dest.precisePoints || []).filter((p) => p.id !== req.params.pointId);
    inland.routeCache = (inland.routeCache || []).filter(
      (rc) => !(rc.destinationId === dest.id && rc.targetType === "precisePoint" && rc.targetId === req.params.pointId)
    );
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.preciseDeleted"), `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
  });

  // S1: edit a precise point's flat price (一口价). Empty clears it (inherit city rate).
  app.post("/admin/inland/destinations/:id/precise-points/:pointId/save", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const dest = (inland.destinations || []).find((d) => d.id === req.params.id);
    const point = dest && (dest.precisePoints || []).find((p) => p.id === req.params.pointId);
    if (!dest || !point) {
      return res.status(404).render("not-found", baseView(req, { pageTitle: req.t("system.notFoundTitle"), languageReturnTo: req.originalUrl }));
    }
    const raw = req.body.flatPrice;
    point.flatPrice = raw !== undefined && String(raw).trim() !== "" ? Number(raw) : null;
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.preciseSaved") || "OK", `${INLAND_ADMIN_TARGET}#dest-${dest.id}`);
  });

  app.post("/admin/inland/rate-entries/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const destinationId = String(req.body.destinationId || "").trim();
    if (!(inland.destinations || []).some((d) => d.id === destinationId)) {
      return redirectWithFlash(req, res, "error", req.t("inland.destRequired"), INLAND_ADMIN_TARGET);
    }
    inland.rateEntries = inland.rateEntries || [];
    inland.rateEntries.push({
      id: `re-${destinationId}-${Date.now().toString(36)}`,
      originId: (inland.origins && inland.origins[0] && inland.origins[0].id) || "manzanillo",
      destinationId,
      proveedor: "",
      sencillo: null,
      full: null,
      currency: "MXN",
      cliente: "",
      codigoCw: "",
      commodity: "",
      enabled: true,
      note: "",
      extras: {},
    });
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.rateAdded"), `${INLAND_ADMIN_TARGET}#dest-${destinationId}`);
  });

  app.post("/admin/inland/rate-entries/save", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const toAmount = (value) => {
      if (value === undefined || value === null || String(value).trim() === "") return null;
      const n = Number(String(value).replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    for (const entry of inland.rateEntries || []) {
      if (req.body[`re_present_${entry.id}`] === undefined) continue;
      const p = req.body[`re_proveedor_${entry.id}`];
      if (p !== undefined) entry.proveedor = String(p).trim();
      if (req.body[`re_sencillo_${entry.id}`] !== undefined) entry.sencillo = toAmount(req.body[`re_sencillo_${entry.id}`]);
      if (req.body[`re_full_${entry.id}`] !== undefined) entry.full = toAmount(req.body[`re_full_${entry.id}`]);
      if (
        req.body[`re_burreoS_${entry.id}`] !== undefined ||
        req.body[`re_burreoF_${entry.id}`] !== undefined
      ) {
        const bS = toAmount(req.body[`re_burreoS_${entry.id}`]);
        const bF = toAmount(req.body[`re_burreoF_${entry.id}`]);
        entry.burreo = bS === null && bF === null ? null : { sencillo: bS, full: bF };
      }
      // S2: the 4 extra vehicle tiers (sencillo/full handled above as legacy fields).
      entry.vehiclePrices = entry.vehiclePrices || {};
      for (const vType of EXTRA_VEHICLE_KEYS) {
        const field = `re_veh_${vType}_${entry.id}`;
        if (req.body[field] !== undefined) {
          entry.vehiclePrices[vType] = toAmount(req.body[field]);
        }
      }
      const cli = req.body[`re_cliente_${entry.id}`];
      if (cli !== undefined) entry.cliente = String(cli).trim();
      const cw = req.body[`re_codigocw_${entry.id}`];
      if (cw !== undefined) entry.codigoCw = String(cw).trim();
      const com = req.body[`re_commodity_${entry.id}`];
      if (com !== undefined) entry.commodity = String(com).trim();
      const note = req.body[`re_note_${entry.id}`];
      if (note !== undefined) entry.note = String(note);
      entry.enabled = req.body[`re_enabled_${entry.id}`] !== undefined;
    }
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(req, res, "success", req.t("inland.saved"), INLAND_ADMIN_TARGET);
  });

  app.post("/admin/inland/rate-entries/:id/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const inland = structuredClone(getModuleData(shippingData, "inland"));
    const entry = (inland.rateEntries || []).find((e) => e.id === req.params.id);
    inland.rateEntries = (inland.rateEntries || []).filter((e) => e.id !== req.params.id);
    shippingData.modules.inland = inland;
    await saveShippingData(shippingData);
    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("inland.rateDeleted"),
      entry ? `${INLAND_ADMIN_TARGET}#dest-${entry.destinationId}` : INLAND_ADMIN_TARGET
    );
  });

  app.get("/admin", requireAuth, (_req, res) => {
    res.redirect(`/admin/${DEFAULT_MODULE_KEY}/settings`);
  });

  app.get("/admin/:moduleKey/settings", requireAuth, async (req, res) => {
    const module = getBusinessModule(req.params.moduleKey);
    if (!module) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    // Inland has no shipping-line / container-type settings; its admin lives on
    // the rules page (destinations, addresses, routes, rates).
    if (module.key === "inland") {
      return res.redirect("/admin/inland/shipping-lines");
    }

    // Q2 (20260617): quote has a real admin page — number format + remarks library.
    if (module.key === "quote") {
      const shippingData = await loadShippingData();
      const quote = getModuleData(shippingData, "quote");
      const moduleMeta = getModulePresentation("quote", req.language);
      return res.render(
        "admin-quote",
        baseView(req, {
          pageTitle: `${moduleMeta.title} | ${req.t("app.name")}`,
          currentArea: "admin",
          currentModuleKey: "quote",
          currentAdminSection: "settings",
          selectedModule: moduleMeta,
          quoteSettings: quote.settings,
          quoteNotes: quote.notes || [],
          languageReturnTo: req.originalUrl,
        })
      );
    }

    const shippingData = await loadShippingData();
    return renderAdminSettings(req, res, {
      moduleKey: module.key,
      moduleData: getModuleData(shippingData, module.key),
      exchangeRates: shippingData.exchangeRates,
    });
  });

  app.post("/admin/:moduleKey/settings", requireAuth, async (req, res) => {
    const module = getBusinessModule(req.params.moduleKey);
    if (!module) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    // Q2/Q11: save quote number format + remarks library.
    if (module.key === "quote") {
      const shippingData = await loadShippingData({ refreshRates: false });
      const quote = structuredClone(getModuleData(shippingData, "quote"));
      const b = req.body;
      if (typeof b.quoteNumberPrefix === "string") quote.settings.quoteNumberPrefix = b.quoteNumberPrefix.trim();
      if (typeof b.quoteNumberSuffix === "string") quote.settings.quoteNumberSuffix = b.quoteNumberSuffix.trim();
      if (b.quoteNumberPad !== undefined) quote.settings.quoteNumberPad = Math.max(1, Math.min(8, parseWholeNumber(b.quoteNumberPad, 3) || 3));
      if (b.lastQuoteSeq !== undefined) quote.settings.lastQuoteSeq = Math.max(0, parseWholeNumber(b.lastQuoteSeq, 0));
      const ids = ensureArray(b.note_id);
      const ens = ensureArray(b.note_en);
      const zhs = ensureArray(b.note_zh);
      const ess = ensureArray(b.note_es);
      quote.notes = ids
        .map((id, i) => ({
          id: String(id || `note-${i + 1}`),
          en: String(ens[i] || "").trim(),
          es: String(ess[i] || "").trim(),
          zh: String(zhs[i] || "").trim(),
        }))
        .filter((n) => n.en || n.zh || n.es);
      shippingData.modules.quote = quote;
      await saveShippingData(shippingData);
      return redirectWithFlash(req, res, "success", req.t("quote.adminSaved"), "/admin/quote/settings");
    }

    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = getModuleData(shippingData, module.key);
    const taxRatePresets = buildTaxRatePresets(req.body);

    shippingData.modules[module.key] = {
      ...moduleData,
      settings: {
        ...moduleData.settings,
        defaultQuoteCurrency:
          req.body.defaultQuoteCurrency || moduleData.settings.defaultQuoteCurrency,
        defaultPriceMode:
          req.body.defaultPriceMode || moduleData.settings.defaultPriceMode,
      },
      taxRatePresets: taxRatePresets.length
        ? taxRatePresets
        : moduleData.taxRatePresets,
    };

    await saveShippingData(shippingData);
    req.session.flash = {
      type: "success",
      message: req.t("admin.settingsSaved", {
        module: req.t(`modules.${module.key}.title`),
      }),
    };
    return res.redirect(`/admin/${module.key}/settings`);
  });

  app.post(
    "/admin/:moduleKey/exchange-rates/refresh",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({
        refreshRates: true,
        forceRefreshRates: true,
      });
      await saveShippingData(shippingData);
      req.session.flash = {
        type: "success",
        message: req.t("admin.exchangeRatesSaved"),
      };
      return res.redirect(`/admin/${module.key}/settings`);
    }
  );

  // --- Container type master (editable on handover; shared with customs) ---
  app.post(
    "/admin/handover/container-types/add",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "handover"));
      const existing = moduleData.containerTypes || [];
      const key = String(req.body.ct_new_key || "").trim();
      const label = String(req.body.ct_new_label || "").trim();
      const rateGroup = String(req.body.ct_new_rateGroup || "").trim();
      const target = "/admin/handover/settings#container-types";

      if (!key) {
        return redirectWithFlash(req, res, "error", req.t("containerTypes.keyRequired"), target);
      }
      if (existing.some((type) => type.key === key)) {
        return redirectWithFlash(req, res, "error", req.t("containerTypes.keyExists", { key }), target);
      }
      if (!RATE_GROUP_NAMES.includes(rateGroup)) {
        return redirectWithFlash(req, res, "error", req.t("containerTypes.rateGroupRequired"), target);
      }

      moduleData.containerTypes = [...existing, { key, label: label || key, rateGroup }];
      shippingData.modules.handover = moduleData;
      await saveShippingData(shippingData);
      return redirectWithFlash(req, res, "success", req.t("containerTypes.added", { name: label || key }), target);
    }
  );

  app.post(
    "/admin/handover/container-types/save",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "handover"));
      moduleData.containerTypes = (moduleData.containerTypes || []).map((type) => {
        const label =
          String(req.body[`ct_label_${type.key}`] ?? type.label).trim() || type.key;
        const rateGroupInput = String(req.body[`ct_rateGroup_${type.key}`] || "").trim();
        const rateGroup = RATE_GROUP_NAMES.includes(rateGroupInput)
          ? rateGroupInput
          : type.rateGroup;
        return { key: type.key, label, rateGroup };
      });
      shippingData.modules.handover = moduleData;
      await saveShippingData(shippingData);
      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("containerTypes.saved"),
        "/admin/handover/settings#container-types"
      );
    }
  );

  app.post(
    "/admin/handover/container-types/:key/delete",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "handover"));
      const existing = moduleData.containerTypes || [];
      const key = req.params.key;
      const target = "/admin/handover/settings#container-types";

      if (!existing.some((type) => type.key === key)) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }
      if (existing.length <= 1) {
        return redirectWithFlash(req, res, "error", req.t("containerTypes.keepOne"), target);
      }

      const force = req.query.force === "1";
      const refs = countCustomsContainerReferences(
        getModuleData(shippingData, "customs"),
        key
      );
      if (refs > 0 && !force) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("containerTypes.deleteBlocked", { key, count: refs }),
          target
        );
      }

      // Removing the type from the master drops its customs rate entries
      // automatically on the next normalize (ensureRatesForContainerTypes).
      moduleData.containerTypes = existing.filter((type) => type.key !== key);
      shippingData.modules.handover = moduleData;
      await saveShippingData(shippingData);
      return redirectWithFlash(req, res, "success", req.t("containerTypes.deleted", { name: key }), target);
    }
  );

  app.get("/admin/customs/shipping-lines", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData();
    return renderAdminRules(req, res, {
      moduleKey: "customs",
      moduleData: getModuleData(shippingData, "customs"),
    });
  });

  // O1 (20260617): defensive GET handlers for /admin/customs/ports/:id and
  // /admin/customs/terminals/:id. All editing happens via POST sub-routes on the
  // one shipping-lines page; these entity URLs have no GET, so a stray GET
  // (shared/bookmarked anchor, browser prefetch, back-button to a redirect
  // target, or a hand-typed URL) 404'd. Redirect to the page anchored on the
  // entity instead of erroring (José: "加港口 404").
  app.get("/admin/customs/ports/:portId", requireAuth, (req, res) => {
    return res.redirect(
      `/admin/customs/shipping-lines#customs-port-${req.params.portId}`
    );
  });
  app.get("/admin/customs/terminals/:terminalId", requireAuth, (req, res) => {
    return res.redirect(
      `/admin/customs/shipping-lines#customs-terminal-${req.params.terminalId}`
    );
  });

  app.post("/admin/customs/ports/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const port = buildCustomsPortDraft(moduleData, req.t);
    moduleData.ports = [...(moduleData.ports || []), port];
    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);

    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("customs.entityAdded", { name: port.name }),
      `/admin/customs/shipping-lines#customs-port-${port.id}`
    );
  });

  // O3b (20260617): delete a port and cascade-delete its terminals (the terminals
  // are nested under the port, so removing the port drops them too).
  app.post("/admin/customs/ports/:portId/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const beforeCount = (moduleData.ports || []).length;
    moduleData.ports = (moduleData.ports || []).filter(
      (entry) => entry.id !== req.params.portId
    );
    const removed = beforeCount !== moduleData.ports.length;
    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);

    return redirectWithFlash(
      req,
      res,
      removed ? "success" : "error",
      removed ? req.t("customs.portDeleted") : req.t("system.notFoundTitle"),
      "/admin/customs/shipping-lines#customs-terminal-rules"
    );
  });

  app.post(
    "/admin/customs/ports/:portId/terminals/add",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const portEntry = (moduleData.ports || []).find(
        (entry) => entry.id === req.params.portId
      );

      if (!portEntry) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const terminal = buildCustomsTerminalDraft(moduleData, portEntry, req.t);
      portEntry.terminals = [...(portEntry.terminals || []), terminal];
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("customs.entityAdded", { name: terminal.name }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/delete",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { portEntry, terminal } = findCustomsTerminal(
        moduleData,
        req.params.terminalId
      );

      if (!portEntry || !terminal) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const ruleSetCount = (terminal.storageRuleSets || []).length;
      portEntry.terminals = (portEntry.terminals || []).filter(
        (entry) => entry.id !== terminal.id
      );
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("customs.terminalDeleted", {
          name: terminal.name,
          count: ruleSetCount,
        }),
        "/admin/customs/shipping-lines#customs-terminal-rules"
      );
    }
  );

  app.post("/admin/customs/yards/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const yard = buildCustomsYardDraft(moduleData, req.t);
    moduleData.yards = [...(moduleData.yards || []), yard];
    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);

    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("customs.entityAdded", { name: yard.name }),
      `/admin/customs/shipping-lines#customs-yard-${yard.id}`
    );
  });

  app.post("/admin/customs/yards/:yardId/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const yard = (moduleData.yards || []).find(
      (entry) => entry.id === req.params.yardId
    );

    if (!yard) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    const portCount = (yard.portIds || []).length;
    const linkedLineIds = new Set(yard.shippingLineIds || []);
    for (const line of moduleData.shippingLines || []) {
      if ((line.yardIds || []).includes(yard.id)) {
        linkedLineIds.add(line.id);
      }
      line.yardIds = (line.yardIds || []).filter((yardId) => yardId !== yard.id);
    }
    moduleData.yards = (moduleData.yards || []).filter(
      (entry) => entry.id !== yard.id
    );
    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);

    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("customs.yardDeleted", {
        name: yard.name,
        ports: portCount,
        lines: linkedLineIds.size,
      }),
      "/admin/customs/shipping-lines#customs-yard-rules"
    );
  });

  app.post(
    "/admin/customs/terminals/:terminalId/storage-rule-sets/add",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);

      if (!terminal) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const ruleSet = buildCustomsStorageRuleSetDraft(
        moduleData,
        terminal,
        req.t
      );
      terminal.storageRuleSets = [...(terminal.storageRuleSets || []), ruleSet];
      syncTerminalStorageRulesByContainer(terminal, moduleData.shippingLines, moduleData.containerTypes);
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleSetAdded", { label: ruleSet.name }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage-rule-sets/:ruleSetId/add",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);
      const ruleSet = terminal?.storageRuleSets?.find(
        (entry) => entry.id === req.params.ruleSetId
      );

      if (!terminal || !ruleSet) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      ruleSet.rules = ruleSet.rules || [];
      appendProgressiveRule(
        ruleSet.rules,
        `${terminal.id}-${ruleSet.id}`,
        ruleSet.name
      );
      resequenceRules(ruleSet.rules);
      syncTerminalStorageRulesByContainer(terminal, moduleData.shippingLines, moduleData.containerTypes);
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleAdded", { label: ruleSet.name }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage-rule-sets/:ruleSetId/delete",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);
      const ruleSets = terminal?.storageRuleSets || [];
      const ruleSet = ruleSets.find((entry) => entry.id === req.params.ruleSetId);

      if (!terminal || !ruleSet) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      if (ruleSets.length <= 1) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("admin.cannotDeleteLastRuleSet"),
          `/admin/customs/shipping-lines#customs-storage-rule-${terminal.id}-${ruleSet.id}`
        );
      }

      const assignmentCount = unassignStorageRuleSetAssignments(
        terminal,
        ruleSet.id,
        moduleData.shippingLines,
        moduleData.containerTypes
      );
      terminal.storageRuleSets = ruleSets.filter(
        (entry) => entry.id !== ruleSet.id
      );
      syncTerminalStorageRulesByContainer(
        terminal,
        moduleData.shippingLines,
        moduleData.containerTypes
      );
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("customs.storageRuleSetDeleted", {
          name: ruleSet.name,
          count: assignmentCount,
        }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage-rule-sets/:ruleSetId/:ruleId/delete",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);
      const ruleSet = terminal?.storageRuleSets?.find(
        (entry) => entry.id === req.params.ruleSetId
      );

      if (!terminal || !ruleSet) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      ruleSet.rules = ruleSet.rules || [];
      if (!removeProgressiveRule(ruleSet.rules, req.params.ruleId)) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("admin.cannotDeleteLastRule"),
          `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
        );
      }

      resequenceRules(ruleSet.rules);
      syncTerminalStorageRulesByContainer(terminal, moduleData.shippingLines, moduleData.containerTypes);
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);
      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleDeleted", { label: ruleSet.name }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage/:groupKey/add",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);
      const containerType = (moduleData.containerTypes || []).find(
        (type) => type.key === req.params.groupKey
      );

      if (!terminal || !containerType) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const ruleSet = findAssignedStorageRuleSet(terminal, containerType.key);
      const rules =
        ruleSet?.rules || terminal.storageRulesByContainer?.[containerType.key] || [];
      appendProgressiveRule(
        rules,
        `${terminal.id}-${ruleSet?.id || containerType.key}`,
        ruleSet?.name || containerType.label
      );
      resequenceRules(rules);
      if (ruleSet) {
        ruleSet.rules = rules;
        syncTerminalStorageRulesByContainer(terminal, moduleData.shippingLines, moduleData.containerTypes);
      } else {
        terminal.storageRulesByContainer[containerType.key] = rules;
      }
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleAdded", { label: containerType.label }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage/:groupKey/:ruleId/delete",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);
      const containerType = (moduleData.containerTypes || []).find(
        (type) => type.key === req.params.groupKey
      );

      if (!terminal || !containerType) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const ruleSet = findAssignedStorageRuleSet(terminal, containerType.key);
      const rules =
        ruleSet?.rules || terminal.storageRulesByContainer?.[containerType.key] || [];
      if (!removeProgressiveRule(rules, req.params.ruleId)) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("admin.cannotDeleteLastRule"),
          `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
        );
      }

      resequenceRules(rules);
      if (ruleSet) {
        ruleSet.rules = rules;
        syncTerminalStorageRulesByContainer(terminal, moduleData.shippingLines, moduleData.containerTypes);
      }
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);
      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleDeleted", { label: containerType.label }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  async function removeCustomsStorageAssignment(
    req,
    res,
    { terminalId, lineId, containerTypeKey, returnRuleSetId = "" }
  ) {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const { terminal } = findCustomsTerminal(moduleData, terminalId);
    const shippingLine = (moduleData.shippingLines || []).find(
      (line) => line.id === lineId
    );
    const containerType = (moduleData.containerTypes || []).find(
      (type) => type.key === containerTypeKey
    );

    if (!terminal || !shippingLine || !containerType) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    if (terminal.storageAssignmentsByLineContainer?.[shippingLine.id]) {
      delete terminal.storageAssignmentsByLineContainer[shippingLine.id][
        containerType.key
      ];
    }

    const assignmentKey = getLineContainerAssignmentKey(
      shippingLine.id,
      containerType.key
    );
    terminal.storageUnassignedLineContainers = uniqueIds([
      ...(terminal.storageUnassignedLineContainers || []),
      assignmentKey,
    ]);
    syncTerminalStorageRulesByContainer(
      terminal,
      moduleData.shippingLines,
      moduleData.containerTypes
    );
    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);

    const safeReturnRuleSetId = String(returnRuleSetId || "");
    const returnRuleSetExists = (terminal.storageRuleSets || []).some(
      (ruleSet) => ruleSet.id === safeReturnRuleSetId
    );
    const returnHash = returnRuleSetExists
      ? `customs-storage-rule-${terminal.id}-${safeReturnRuleSetId}`
      : `customs-terminal-${terminal.id}`;

    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("customs.storageAssignmentRemoved", {
        line: shippingLine.name,
        type: containerType.label,
      }),
      `/admin/customs/shipping-lines#${returnHash}`
    );
  }

  app.post(
    "/admin/customs/terminals/:terminalId/storage-assignments/release",
    requireAuth,
    async (req, res) => {
      const returnRuleSetId = String(req.body.releaseRuleSetId || "");
      const assignmentKey = String(
        req.body[`releaseLineContainerKey_${returnRuleSetId}`] || ""
      );
      const [lineId, containerTypeKey] = assignmentKey.split("::");
      return removeCustomsStorageAssignment(req, res, {
        terminalId: req.params.terminalId,
        lineId,
        containerTypeKey,
        returnRuleSetId,
      });
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage-assignments/:lineId/:containerTypeKey/delete",
    requireAuth,
    async (req, res) => {
      return removeCustomsStorageAssignment(req, res, {
        terminalId: req.params.terminalId,
        lineId: req.params.lineId,
        containerTypeKey: req.params.containerTypeKey,
        returnRuleSetId: req.query.returnRuleSetId,
      });
    }
  );

  app.post("/admin/customs/shipping-lines", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const yardSelectionsByLine = {};

    for (const line of moduleData.shippingLines || []) {
      line.notes = req.body[`customs_line_note_${line.id}`] || line.notes || null;
      line.yardIds = uniqueIds(ensureArray(req.body[`shippingLine_yardIds_${line.id}`]));
      yardSelectionsByLine[line.id] = new Set(line.yardIds);
    }

    for (const portEntry of moduleData.ports || []) {
      portEntry.name = req.body[`port_name_${portEntry.id}`] || portEntry.name;
      portEntry.note = req.body[`port_note_${portEntry.id}`] || null;

      for (const terminal of portEntry.terminals || []) {
        terminal.name = req.body[`terminal_name_${terminal.id}`] || terminal.name;
        terminal.note = req.body[`terminal_note_${terminal.id}`] || null;

        for (const charge of terminal.fixedCharges || []) {
          const chargePrefix = `terminal_charge_${terminal.id}_${charge.id}`;
          charge.concept =
            req.body[`terminal_charge_concept_${terminal.id}_${charge.id}`] || charge.concept;
          charge.note =
            req.body[`terminal_charge_note_${terminal.id}_${charge.id}`] || null;
          charge.taxRate = parseNumber(
            req.body[`terminal_charge_tax_${terminal.id}_${charge.id}`],
            charge.taxRate
          );
          // O3: per-charge config (basis / required / flat amount).
          charge.basis =
            req.body[`${chargePrefix}_basis`] === "per_day"
              ? "per_day"
              : "per_occurrence";
          charge.required = req.body[`${chargePrefix}_required`] === "on";
          const amountRaw = req.body[`${chargePrefix}_amount`];
          charge.amount =
            amountRaw !== undefined && String(amountRaw).trim() !== ""
              ? parseNumber(amountRaw, 0)
              : null;
          charge.amountCurrency =
            req.body[`${chargePrefix}_amountCurrency`] || charge.amountCurrency || "MXN";

          for (const type of moduleData.containerTypes || []) {
            applyRateCellUpdates(
              charge.groupRates?.[type.key],
              req.body,
              `terminal_charge_${terminal.id}_${charge.id}_${type.key}`
            );
          }
        }

        if (!terminal.storageRuleSets?.length) {
          terminal.storageRuleSets = [
            buildCustomsStorageRuleSetDraft(moduleData, terminal, req.t),
          ];
        }

        const validLineContainerKeys = new Set();
        for (const line of moduleData.shippingLines || []) {
          for (const type of moduleData.containerTypes || []) {
            validLineContainerKeys.add(
              getLineContainerAssignmentKey(line.id, type.key)
            );
          }
        }
        const storageAssignmentsByLineContainer = {};
        const storageUnassignedLineContainers = new Set(
          terminal.storageUnassignedLineContainers || []
        );
        for (const ruleSet of terminal.storageRuleSets || []) {
          ruleSet.rules = ruleSet.rules || [];
          ruleSet.name =
            req.body[`terminal_storage_set_${terminal.id}_${ruleSet.id}_name`] ||
            ruleSet.name;

          const selectedLineContainerKeys = uniqueIds(
            ensureArray(
              req.body[
                `terminal_storage_set_${terminal.id}_${ruleSet.id}_lineContainers`
              ]
            )
          );
          for (const assignmentKey of selectedLineContainerKeys) {
            if (!validLineContainerKeys.has(assignmentKey)) {
              continue;
            }

            const [lineId, typeKey] = assignmentKey.split("::");
            storageAssignmentsByLineContainer[lineId] =
              storageAssignmentsByLineContainer[lineId] || {};
            if (!storageAssignmentsByLineContainer[lineId][typeKey]) {
              storageAssignmentsByLineContainer[lineId][typeKey] = ruleSet.id;
              storageUnassignedLineContainers.delete(assignmentKey);
            }
          }

          const updateResult = applySequentialRuleUpdates({
            rules: ruleSet.rules,
            body: req.body,
            getPrefix: (rule) =>
              `terminal_storage_set_${terminal.id}_${ruleSet.id}_${rule.id}`,
            t: req.t,
          });
          if (!updateResult.ok) {
            return redirectWithFlash(
              req,
              res,
              "error",
              updateResult.message,
              `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
            );
          }
        }

        const fallbackStorageRuleSetId = terminal.storageRuleSets?.[0]?.id;
        for (const line of moduleData.shippingLines || []) {
          storageAssignmentsByLineContainer[line.id] =
            storageAssignmentsByLineContainer[line.id] || {};
          for (const type of moduleData.containerTypes || []) {
            const assignmentKey = getLineContainerAssignmentKey(line.id, type.key);
            if (
              !storageAssignmentsByLineContainer[line.id][type.key] &&
              !storageUnassignedLineContainers.has(assignmentKey)
            ) {
              storageAssignmentsByLineContainer[line.id][type.key] =
                fallbackStorageRuleSetId;
            }
          }
        }
        terminal.storageAssignmentsByLineContainer =
          storageAssignmentsByLineContainer;
        terminal.storageUnassignedLineContainers = [...storageUnassignedLineContainers]
          .filter((assignmentKey) => validLineContainerKeys.has(assignmentKey));
        syncTerminalStorageRulesByContainer(
          terminal,
          moduleData.shippingLines,
          moduleData.containerTypes
        );
      }
    }

    for (const yard of moduleData.yards || []) {
      yard.name = req.body[`yard_name_${yard.id}`] || yard.name;
      yard.note = req.body[`yard_note_${yard.id}`] || null;
      yard.portIds = uniqueIds(ensureArray(req.body[`yard_portIds_${yard.id}`]));
      const directShippingLineIds = uniqueIds(
        ensureArray(req.body[`yard_shippingLineIds_${yard.id}`])
      );
      const linkedFromLines = moduleData.shippingLines
        .filter((line) => yardSelectionsByLine[line.id]?.has(yard.id))
        .map((line) => line.id);
      yard.shippingLineIds = uniqueIds([...directShippingLineIds, ...linkedFromLines]);

      for (const charge of yard.dropoffCharges || []) {
        charge.concept = req.body[`yard_dropoff_concept_${yard.id}_${charge.id}`] || charge.concept;
        charge.note = req.body[`yard_dropoff_note_${yard.id}_${charge.id}`] || null;
        charge.taxRate = parseNumber(
          req.body[`yard_dropoff_tax_${yard.id}_${charge.id}`],
          charge.taxRate
        );
        for (const type of moduleData.containerTypes || []) {
          applyRateCellUpdates(
            charge.groupRates?.[type.key],
            req.body,
            `yard_dropoff_${yard.id}_${charge.id}_${type.key}`
          );
        }
      }

      for (const charge of yard.customsCharges || []) {
        charge.concept = req.body[`yard_customs_concept_${yard.id}_${charge.id}`] || charge.concept;
        charge.note = req.body[`yard_customs_note_${yard.id}_${charge.id}`] || null;
        charge.taxRate = parseNumber(
          req.body[`yard_customs_tax_${yard.id}_${charge.id}`],
          charge.taxRate
        );
        for (const type of moduleData.containerTypes || []) {
          applyRateCellUpdates(
            charge.groupRates?.[type.key],
            req.body,
            `yard_customs_${yard.id}_${charge.id}_${type.key}`
          );
        }
      }
    }

    for (const line of moduleData.shippingLines || []) {
      const linkedYards = moduleData.yards
        .filter((yard) => yard.shippingLineIds.includes(line.id))
        .map((yard) => yard.id);
      line.yardIds = uniqueIds([...(line.yardIds || []), ...linkedYards]);
    }

    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);
    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("admin.customsRulesSaved"),
      "/admin/customs/shipping-lines"
    );
  });

  app.get("/admin/:moduleKey/shipping-lines", requireAuth, async (req, res) => {
    const module = getBusinessModule(req.params.moduleKey);
    if (!module) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    if (module.key === "quote") {
      return res.redirect("/workbench/quote");
    }

    const shippingData = await loadShippingData();
    return renderAdminRules(req, res, {
      moduleKey: module.key,
      moduleData: getModuleData(shippingData, module.key),
      selectedLine: null,
    });
  });

  app.get("/admin/:moduleKey/shipping-lines/:id", requireAuth, async (req, res) => {
    const module = getBusinessModule(req.params.moduleKey);
    if (!module) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    if (module.key === "customs") {
      return res.redirect("/admin/customs/shipping-lines");
    }

    const shippingData = await loadShippingData();
    const moduleData = getModuleData(shippingData, module.key);
    const selectedLine =
      moduleData.shippingLines.find((entry) => entry.id === req.params.id) || null;

    if (!selectedLine) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    return renderAdminRules(req, res, {
      moduleKey: module.key,
      moduleData,
      selectedLine,
    });
  });

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/terminal-mix/add",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module || module.key === "customs") {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = getModuleData(shippingData, module.key);
      const lineIndex = moduleData.shippingLines.findIndex(
        (entry) => entry.id === req.params.id
      );

      if (lineIndex < 0) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const updated = structuredClone(moduleData.shippingLines[lineIndex]);
      const entry = buildTerminalMixDraft(updated, req.t);
      updated.terminalMix = [...(updated.terminalMix || []), entry];
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.terminalMixAdded", { name: entry.terminal }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/terminal-mix/:mixId/delete",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module || module.key === "customs") {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = getModuleData(shippingData, module.key);
      const lineIndex = moduleData.shippingLines.findIndex(
        (entry) => entry.id === req.params.id
      );

      if (lineIndex < 0) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const updated = structuredClone(moduleData.shippingLines[lineIndex]);
      const beforeCount = updated.terminalMix?.length || 0;
      updated.terminalMix = (updated.terminalMix || []).filter(
        (entry) => entry.id !== req.params.mixId
      );
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        beforeCount === updated.terminalMix.length ? "error" : "success",
        beforeCount === updated.terminalMix.length
          ? req.t("system.notFoundTitle")
          : req.t("admin.terminalMixDeleted"),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/local-charges/add",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module || module.key === "customs") {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = getModuleData(shippingData, module.key);
      const lineIndex = moduleData.shippingLines.findIndex(
        (entry) => entry.id === req.params.id
      );

      if (lineIndex < 0) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const updated = structuredClone(moduleData.shippingLines[lineIndex]);
      const charge = buildLocalChargeDraft(updated, moduleData, req.t);
      updated.localCharges = [...(updated.localCharges || []), charge];
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.localChargeAdded", { name: charge.concept }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  // H1 (20260617): per-row delete for local charges (mirrors terminal-mix delete).
  app.post(
    "/admin/:moduleKey/shipping-lines/:id/local-charges/:chargeId/delete",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module || module.key === "customs") {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = getModuleData(shippingData, module.key);
      const lineIndex = moduleData.shippingLines.findIndex(
        (entry) => entry.id === req.params.id
      );

      if (lineIndex < 0) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const updated = structuredClone(moduleData.shippingLines[lineIndex]);
      const beforeCount = updated.localCharges?.length || 0;
      updated.localCharges = (updated.localCharges || []).filter(
        (entry) => entry.id !== req.params.chargeId
      );
      const removed = beforeCount !== updated.localCharges.length;
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        removed ? "success" : "error",
        removed
          ? req.t("admin.localChargeDeleted")
          : req.t("system.notFoundTitle"),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/demurrage-rule-sets/add",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module || module.key === "customs") {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = getModuleData(shippingData, module.key);
      const lineIndex = moduleData.shippingLines.findIndex(
        (entry) => entry.id === req.params.id
      );

      if (lineIndex < 0) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const updated = structuredClone(moduleData.shippingLines[lineIndex]);
      // H4: harden against a missing demurrage block so "Agregar set" always works
      // (incl. a line that somehow has 0 rule sets — this bootstraps the first set).
      updated.demurrage = updated.demurrage || {};
      const ruleSets = updated.demurrage.ruleSets || [];
      const ruleSet = {
        id: buildRuleId(`demurrage-set-${updated.id}`),
        name: `${req.t("categories.demurrage")} ${ruleSets.length + 1}`,
        sourceGroupKey: null,
        rules: [],
      };
      appendProgressiveRule(ruleSet.rules, `${updated.id}-${ruleSet.id}`, ruleSet.name);
      resequenceRules(ruleSet.rules);
      ruleSets.push(ruleSet);
      updated.demurrage.ruleSets = ruleSets;
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleAdded", { label: ruleSet.name }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/demurrage-rule-sets/:ruleSetId/add",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module || module.key === "customs") {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = getModuleData(shippingData, module.key);
      const lineIndex = moduleData.shippingLines.findIndex(
        (entry) => entry.id === req.params.id
      );

      if (lineIndex < 0) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const updated = structuredClone(moduleData.shippingLines[lineIndex]);
      const ruleSet = (updated.demurrage.ruleSets || []).find(
        (entry) => entry.id === req.params.ruleSetId
      );
      if (!ruleSet) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      appendProgressiveRule(
        ruleSet.rules,
        `${updated.id}-${ruleSet.id}`,
        ruleSet.name
      );
      resequenceRules(ruleSet.rules);
      if (ruleSet.sourceGroupKey) {
        // H4: guard rulesByGroup — a legacy set with sourceGroupKey but no
        // rulesByGroup map would otherwise throw on add-rule (a "加不了 demoras" path).
        updated.demurrage.rulesByGroup = updated.demurrage.rulesByGroup || {};
        updated.demurrage.rulesByGroup[ruleSet.sourceGroupKey] = ruleSet.rules;
      }
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleAdded", { label: ruleSet.name }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/demurrage-rule-sets/:ruleSetId/:ruleId/delete",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module || module.key === "customs") {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = getModuleData(shippingData, module.key);
      const lineIndex = moduleData.shippingLines.findIndex(
        (entry) => entry.id === req.params.id
      );

      if (lineIndex < 0) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const updated = structuredClone(moduleData.shippingLines[lineIndex]);
      const ruleSet = (updated.demurrage.ruleSets || []).find(
        (entry) => entry.id === req.params.ruleSetId
      );
      if (!ruleSet) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      if (!removeProgressiveRule(ruleSet.rules, req.params.ruleId)) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("admin.cannotDeleteLastRule"),
          `/admin/${module.key}/shipping-lines/${updated.id}`
        );
      }

      resequenceRules(ruleSet.rules);
      if (ruleSet.sourceGroupKey) {
        updated.demurrage.rulesByGroup[ruleSet.sourceGroupKey] = ruleSet.rules;
      }
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveShippingData(shippingData);
      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleDeleted", { label: ruleSet.name }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/demurrage/:groupKey/add",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module || module.key === "customs") {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = getModuleData(shippingData, module.key);
      const lineIndex = moduleData.shippingLines.findIndex(
        (entry) => entry.id === req.params.id
      );

      if (lineIndex < 0) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const updated = structuredClone(moduleData.shippingLines[lineIndex]);
      const group = (updated.containerGroups || []).find(
        (entry) => entry.key === req.params.groupKey
      );
      if (!group) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const rules = updated.demurrage.rulesByGroup?.[group.key] || [];
      appendProgressiveRule(rules, `${updated.id}-${group.key}`, group.label);
      resequenceRules(rules);
      updated.demurrage.rulesByGroup[group.key] = rules;
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleAdded", { label: group.label }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/demurrage/:groupKey/:ruleId/delete",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module || module.key === "customs") {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = getModuleData(shippingData, module.key);
      const lineIndex = moduleData.shippingLines.findIndex(
        (entry) => entry.id === req.params.id
      );

      if (lineIndex < 0) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const updated = structuredClone(moduleData.shippingLines[lineIndex]);
      const group = (updated.containerGroups || []).find(
        (entry) => entry.key === req.params.groupKey
      );
      if (!group) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const rules = updated.demurrage.rulesByGroup?.[group.key] || [];
      if (!removeProgressiveRule(rules, req.params.ruleId)) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("admin.cannotDeleteLastRule"),
          `/admin/${module.key}/shipping-lines/${updated.id}`
        );
      }

      resequenceRules(rules);
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveShippingData(shippingData);
      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleDeleted", { label: group.label }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post("/admin/:moduleKey/shipping-lines/:id", requireAuth, async (req, res) => {
    const module = getBusinessModule(req.params.moduleKey);
    if (!module) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    if (module.key === "customs") {
      return res.redirect("/admin/customs/shipping-lines");
    }

    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = getModuleData(shippingData, module.key);
    const lineIndex = moduleData.shippingLines.findIndex(
      (entry) => entry.id === req.params.id
    );

    if (lineIndex < 0) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    const updated = structuredClone(moduleData.shippingLines[lineIndex]);
    updated.invoiceToConsigneeOnly = req.body.invoiceToConsigneeOnly === "on";
    updated.invoiceNote = req.body.invoiceNote || null;
    updated.demurrageCutoffHandledBy =
      req.body.demurrageCutoffHandledBy || updated.demurrageCutoffHandledBy;
    updated.guarantee.benefitEnabled = req.body.benefitEnabled === "on";
    updated.guarantee.benefitExpiresAt = req.body.benefitExpiresAt || null;
    updated.guarantee.benefitNote = req.body.benefitNote || null;
    updated.guarantee.taxRate = parseNumber(
      req.body.guaranteeTaxRate,
      updated.guarantee.taxRate
    );

    for (const charge of updated.localCharges || []) {
      const concept = String(
        req.body[`charge_concept_${charge.id}`] ?? charge.concept
      ).trim();
      if (concept) {
        charge.concept = concept;
      }
      charge.taxRate = parseNumber(req.body[`charge_tax_${charge.id}`], charge.taxRate);
      // H2/H3: BL + per-group cells are always editable now; upsert creates the
      // rate object when a value is entered into a previously-empty cell.
      upsertRateCell(charge, "blRate", req.body, `charge_bl_${charge.id}`);
      charge.groupRates = charge.groupRates || {};
      for (const group of updated.containerGroups || []) {
        upsertRateCell(
          charge.groupRates,
          group.key,
          req.body,
          `charge_${charge.id}_${group.key}`
        );
      }
    }

    updated.guarantee.ratesByGroup = updated.guarantee.ratesByGroup || {};
    for (const group of updated.containerGroups || []) {
      upsertRateCell(
        updated.guarantee.ratesByGroup,
        group.key,
        req.body,
        `guarantee_${group.key}`
      );
    }

    updated.terminalMix = (updated.terminalMix || [])
      .map((entry) => {
        const port = String(req.body[`terminal_mix_${entry.id}_port`] || entry.port || "")
          .trim();
        const terminal = String(
          req.body[`terminal_mix_${entry.id}_terminal`] || entry.terminal || ""
        ).trim();

        if (!port || !terminal) {
          return null;
        }

        return {
          ...entry,
          port,
          terminal,
          ratio: parsePercentRatio(
            req.body[`terminal_mix_${entry.id}_ratio`],
            entry.ratio
          ),
        };
      })
      .filter(Boolean);

    const validRuleSetIds = new Set((updated.demurrage.ruleSets || []).map((set) => set.id));
    updated.demurrage.assignmentsByContainerType = {};
    for (const type of moduleData.containerTypes || []) {
      const assignedRuleSetId = req.body[`demurrage_assignment_${type.key}`];
      updated.demurrage.assignmentsByContainerType[type.key] =
        validRuleSetIds.has(assignedRuleSetId)
          ? assignedRuleSetId
          : updated.demurrage.ruleSets?.[0]?.id || "";
    }

    updated.demurrage.freeDays.daysByGroup = {};
    for (const ruleSet of updated.demurrage.ruleSets || []) {
      ruleSet.name =
        req.body[`demurrage_set_${ruleSet.id}_name`] ||
        ruleSet.name ||
        ruleSet.id;
      const rules = ruleSet.rules || [];
      const updateResult = applySequentialRuleUpdates({
        rules,
        body: req.body,
        getPrefix: (rule) => `rule_set_${ruleSet.id}_${rule.id}`,
        t: req.t,
      });
      if (!updateResult.ok) {
        return redirectWithFlash(
          req,
          res,
          "error",
          updateResult.message,
          `/admin/${module.key}/shipping-lines/${updated.id}`
        );
      }

      ruleSet.rules = rules;
      if (ruleSet.sourceGroupKey) {
        updated.demurrage.rulesByGroup[ruleSet.sourceGroupKey] = rules;
      }

      for (const rule of rules) {
        if (rule.freeRule && rule.endDay) {
          updated.demurrage.freeDays.daysByGroup[ruleSet.id] = rule.endDay;
        }
      }
    }
    updated.demurrage.freeDays.defaultDays =
      Object.values(updated.demurrage.freeDays.daysByGroup)[0] || 0;

    shippingData.modules[module.key].shippingLines[lineIndex] = updated;
    await saveShippingData(shippingData);
    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("admin.lineSaved", { name: updated.name }),
      `/admin/${module.key}/shipping-lines/${updated.id}`
    );
  });

  app.use((req, res) => {
    res.status(404).render(
      "not-found",
      baseView(req, {
        pageTitle: req.t("system.notFoundTitle"),
        languageReturnTo: req.originalUrl,
      })
    );
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
  startExchangeRateScheduler();
}

module.exports = { createApp };
