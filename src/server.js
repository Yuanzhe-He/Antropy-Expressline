const express = require("express");
const session = require("express-session");
const path = require("node:path");
const {
  computeCalculator,
  computeCustomsCalculator,
  parseNumber,
} = require("./lib/calculate");
const { refreshExchangeRatesIfStale } = require("./lib/exchange-rates");
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
  getTaxRateLabel,
  getLocalizedOptions,
  normalizeBusinessNature,
} = require("./lib/options");
const {
  formatDemurrageRuleLabel,
  getShippingData,
  getUsers,
  saveShippingData,
} = require("./lib/store");

const port = process.env.PORT || 3000;
const sessionSecret =
  process.env.SESSION_SECRET || "jose-expressline-consulting-local";

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
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

function buildHandoverFormData(selectedLine, body, settings) {
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
      : buildDefaultContainerRows(selectedLine?.containerGroups),
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
        : buildDefaultContainerRows(selectedLine?.containerGroups),
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
      result: payload.result || null,
      formData: payload.formData || null,
      priceModeOptions: getLocalizedOptions(PRICE_MODE_OPTIONS, req.t),
      currencyOptions: CURRENCY_OPTIONS,
      businessNatureOptions: buildBusinessNatureOptions(payload.moduleKey, req.t),
      taxOverrideOptions: buildTaxOverrideOptions(payload.moduleData, req.t),
      taxControls,
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
      linkedHandoverContext: payload.linkedHandoverContext || null,
      languageReturnTo: `/workbench/${payload.moduleKey}?restoreLast=1`,
    })
  );
}

function renderWorkbench(req, res, payload) {
  if (payload.moduleKey === "customs") {
    return renderCustomsWorkbench(req, res, payload);
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

function createApp() {
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "../views"));

  app.use(express.urlencoded({ extended: true }));
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
    if (req.session.flash) {
      req.flash = req.session.flash;
      delete req.session.flash;
    }
    next();
  });

  app.get("/", (req, res) => {
    if (!req.session.user) {
      return res.redirect("/login");
    }
    return res.redirect(`/workbench/${DEFAULT_MODULE_KEY}`);
  });

  app.post("/preferences/language", (req, res) => {
    req.session.language = normalizeLanguage(req.body.language, req.language);
    return res.redirect(getSafeReturnTo(req.body.returnTo));
  });

  app.get("/login", (req, res) => {
    res.render(
      "login",
      baseView(req, {
        pageTitle: req.t("login.title"),
        languageReturnTo: "/login",
      })
    );
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
      res.redirect("/login");
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
        moduleData.settings
      );
      result = computeCalculator(
        selectedLine,
        formData,
        {
          exchangeRates: shippingData.exchangeRates,
          settings: moduleData.settings,
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

    const formData = buildHandoverFormData(selectedLine, req.body, moduleData.settings);
    const result = computeCalculator(
      selectedLine,
      formData,
      {
        exchangeRates: shippingData.exchangeRates,
        settings: moduleData.settings,
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

  app.get("/admin/customs/shipping-lines", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData();
    return renderAdminRules(req, res, {
      moduleKey: "customs",
      moduleData: getModuleData(shippingData, "customs"),
    });
  });

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

      const rules = terminal.storageRulesByContainer?.[containerType.key] || [];
      appendProgressiveRule(
        rules,
        `${terminal.id}-${containerType.key}`,
        containerType.label
      );
      resequenceRules(rules);
      terminal.storageRulesByContainer[containerType.key] = rules;
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleAdded", { label: containerType.label }),
        "/admin/customs/shipping-lines"
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

      const rules = terminal.storageRulesByContainer?.[containerType.key] || [];
      if (!removeProgressiveRule(rules, req.params.ruleId)) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("admin.cannotDeleteLastRule"),
          "/admin/customs/shipping-lines"
        );
      }

      resequenceRules(rules);
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);
      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleDeleted", { label: containerType.label }),
        "/admin/customs/shipping-lines"
      );
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
          charge.concept =
            req.body[`terminal_charge_concept_${terminal.id}_${charge.id}`] || charge.concept;
          charge.note =
            req.body[`terminal_charge_note_${terminal.id}_${charge.id}`] || null;
          charge.taxRate = parseNumber(
            req.body[`terminal_charge_tax_${terminal.id}_${charge.id}`],
            charge.taxRate
          );

          for (const type of moduleData.containerTypes || []) {
            applyRateCellUpdates(
              charge.groupRates?.[type.key],
              req.body,
              `terminal_charge_${terminal.id}_${charge.id}_${type.key}`
            );
          }
        }

        for (const type of moduleData.containerTypes || []) {
          const rules = terminal.storageRulesByContainer?.[type.key] || [];
          const updateResult = applySequentialRuleUpdates({
            rules,
            body: req.body,
            getPrefix: (rule) => `terminal_rule_${terminal.id}_${type.key}_${rule.id}`,
            t: req.t,
          });
          if (!updateResult.ok) {
            return redirectWithFlash(
              req,
              res,
              "error",
              updateResult.message,
              "/admin/customs/shipping-lines"
            );
          }
        }
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
      charge.taxRate = parseNumber(req.body[`charge_tax_${charge.id}`], charge.taxRate);
      if (charge.blRate) {
        applyRateCellUpdates(charge.blRate, req.body, `charge_bl_${charge.id}`);
      }
      for (const group of updated.containerGroups || []) {
        applyRateCellUpdates(
          charge.groupRates?.[group.key],
          req.body,
          `charge_${charge.id}_${group.key}`
        );
      }
    }

    for (const group of updated.containerGroups || []) {
      applyRateCellUpdates(
        updated.guarantee.ratesByGroup?.[group.key],
        req.body,
        `guarantee_${group.key}`
      );
    }

    updated.demurrage.freeDays.daysByGroup = {};
    for (const group of updated.containerGroups || []) {
      const rules = updated.demurrage.rulesByGroup?.[group.key] || [];
      const updateResult = applySequentialRuleUpdates({
        rules,
        body: req.body,
        getPrefix: (rule) => `rule_${group.key}_${rule.id}`,
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

      for (const rule of rules) {
        if (rule.freeRule && rule.endDay) {
          updated.demurrage.freeDays.daysByGroup[group.key] = rule.endDay;
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
}

module.exports = { createApp };
