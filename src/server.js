const express = require("express");
const session = require("express-session");
const path = require("node:path");
const {
  computeCalculator,
  computeCustomsCalculator,
  computeInlandCalculator,
  parseNumber,
} = require("./lib/calculate");
const { effectiveRoute } = require("./lib/inland-routes");
const {
  VEHICLE_TYPE_KEYS,
  normalizeVehicleType,
  getVehiclePrice,
} = require("./lib/inland-vehicles");
const { refreshExchangeRatesIfStale } = require("./lib/exchange-rates");
const { startExchangeRateScheduler } = require("./lib/exchange-rate-scheduler");
const usageGuard = require("./lib/usage-guard");
const refreshMonitor = require("./lib/refresh-monitor");
const { attachUser, requireAuth } = require("./middleware/auth");
const { languageMiddleware } = require("./middleware/i18n");
const { safeJsonLocals, flashMiddleware } = require("./middleware/locals");
const healthRoutes = require("./routes/health");
const exchangeRatesRoutes = require("./routes/exchange-rates");
const workbenchRoutes = require("./routes/workbench");
const adminInlandRoutes = require("./routes/admin-inland");
const adminCustomsRoutes = require("./routes/admin-customs");
const adminShippingLinesRoutes = require("./routes/admin-shipping-lines");
const adminHandoverRoutes = require("./routes/admin-handover");
const adminSettingsRoutes = require("./routes/admin-settings");
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
  saveExchangeRates,
  RATE_GROUP_NAMES,
} = require("./lib/store");
const {
  DEFAULT_QUOTE_HEADER,
  QUOTE_DEPARTMENT_OPTIONS,
  QUOTE_INCOTERM_OPTIONS,
  QUOTE_TRANSPORT_MODE_OPTIONS,
  QUOTE_CARGO_TYPE_OPTIONS,
  QUOTE_UOM_OPTIONS,
  QUOTE_GROUP_ORDER,
  QUOTE_MODES,
  normalizeQuoteMode,
  buildInitialLineItems,
  reconcileLineItemsForMode,
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
const {
  ensureArray,
  parseWholeNumber,
  buildRuleId,
} = require("./lib/rule-engine");
const {
  formatTerminalMixSummary,
  buildTaxOverrides,
  buildDefaultContainerRows,
  buildHandoverFormData,
} = require("./lib/handover-forms");

const port = process.env.PORT || 3000;
const sessionSecret =
  process.env.SESSION_SECRET || "jose-expressline-consulting-local";
// auth (publicDemoUser/attachUser/requireAuth) moved to ./middleware/auth.

function redirectWithFlash(req, res, type, message, target) {
  req.session.flash = { type, message };
  return res.redirect(target);
}

function getModuleData(shippingData, moduleKey) {
  const normalizedModuleKey = normalizeModuleKey(moduleKey);
  return (
    shippingData.modules?.[normalizedModuleKey] ||
    shippingData.modules?.[DEFAULT_MODULE_KEY]
  );
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
      // Persist ONLY exchangeRates (targeted), so this frequent write cannot
      // clobber concurrent carrier/customs/inland edits. See saveExchangeRates.
      await saveExchangeRates(refreshed.data);
      shippingData = refreshed.data;
    }
  }
  return shippingData;
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
    quoteMode: formData.quoteMode,
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
  // Quote mode (round11): posted value wins; a fresh quote falls back to the
  // admin default preset, then mexico_only (legacy behavior / back-compat).
  const quoteMode = normalizeQuoteMode(
    body.quoteMode || quoteModule.settings?.headerDefaults?.quoteMode || "mexico_only"
  );
  // Fresh quote -> seed rows for the mode. Posted quote -> keep the operator's
  // rows but reconcile against the (possibly just-changed) mode: mexico_only
  // drops foreign rows; ocean_mexico injects the foreign block when missing.
  const lineItems = hasPostedRows
    ? reconcileLineItemsForMode(parseQuoteLineItems(body), quoteMode)
    : buildInitialLineItems(quoteMode);
  const number =
    (body.quotationNumber || "").trim() || generateQuoteNumber(quoteModule.settings).number;
  const today = new Date().toISOString().slice(0, 10);
  // Q11: ordered subset of remark-library ids to print. A fresh quote (nothing
  // posted) defaults to ALL remarks selected.
  const libraryIds = (quoteModule.notes || []).map((n) => n.id);
  const postedNoteIds = ensureArray(body.note_sel).map(String);
  const language = pickFromOptions(body.quoteLang, ["EN", "ZH", "ES"], "");
  const header = parseQuoteHeader(body);
  // S5: pre-fill a fresh quote's header from the admin default preset.
  if (!hasPostedRows) {
    const hd = quoteModule.settings?.headerDefaults || {};
    if (hd.department) header.department = hd.department;
    if (hd.transportMode) header.transportMode = hd.transportMode;
    if (hd.incoterm) header.incoterm = hd.incoterm;
    if (hd.cargoType) header.cargoType = hd.cargoType;
  }
  return {
    number,
    date: (body.date || "").trim() || options.date || today,
    header,
    quoteMode,
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
      categoryOptions: QUOTE_GROUP_ORDER,
      quoteModes: QUOTE_MODES,
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

  // Middleware order is behavior-sensitive \u2014 keep this exact sequence:
  // language \u2192 user \u2192 safeJson locals \u2192 flash. (Extracted to ./middleware/*.)
  app.use(languageMiddleware);
  app.use(attachUser);
  app.use(safeJsonLocals);
  app.use(flashMiddleware);

  app.get("/", (req, res) => {
    return res.redirect(`/workbench/${DEFAULT_MODULE_KEY}`);
  });

  healthRoutes.register(app); // GET /healthz

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

  const workbenchCtx = {
    baseView, loadShippingData, getModuleData, redirectWithFlash, buildRuleId,
    renderWorkbench, renderQuoteWorkbench, rememberCalculatorState, rememberLinkedWorkflow,
    getSelectedLine, buildHandoverFormData, buildDefaultHandoverFormData,
    buildCustomsFormData, buildDefaultCustomsFormData, resolveCustomsSelections,
    buildInlandFormData, buildDefaultInlandFormData,
    buildQuoteFormData, assembleQuoteView, buildQuoteSelectorData,
  };
  workbenchRoutes.register(app, workbenchCtx);
  adminInlandRoutes.register(app, {
    loadShippingData,
    getModuleData,
    redirectWithFlash,
    baseView,
  });

  adminSettingsRoutes.register(app, {
    loadShippingData,
    getModuleData,
    baseView,
    redirectWithFlash,
    renderAdminSettings,
    pickFromOptions,
  });

  // POST /admin/:moduleKey/exchange-rates/refresh (extracted to ./routes/exchange-rates)
  exchangeRatesRoutes.register(app, { requireAuth, loadShippingData, baseView });

  adminHandoverRoutes.register(app, {
    loadShippingData,
    getModuleData,
    redirectWithFlash,
    baseView,
  });

  adminCustomsRoutes.register(app, {
    loadShippingData,
    getModuleData,
    redirectWithFlash,
    baseView,
    renderAdminRules,
  });

  adminShippingLinesRoutes.register(app, {
    loadShippingData,
    getModuleData,
    redirectWithFlash,
    baseView,
    renderAdminRules,
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
    // Make the guardrails visible at startup (Railway logs).
    const ttlMs = Number(process.env.SHIPPING_CACHE_TTL_MS) || 60 * 60 * 1000;
    console.log(
      `shipping-data read cache TTL: ${Math.round(ttlMs / 1000)}s | ${usageGuard.describeConfig()}`
    );
  });
  startExchangeRateScheduler();
}

module.exports = { createApp };
