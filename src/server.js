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

const {
  redirectWithFlash,
  getModuleData,
  loadShippingData,
  buildModuleLinks,
  getSafeReturnTo,
  baseView,
  getSelectedLine,
  buildDefaultHandoverFormData,
  resolveCustomsSelections,
  buildDefaultCustomsFormData,
  buildCustomsFormData,
  rememberCalculatorState,
  rememberLinkedWorkflow,
  buildBusinessNatureOptions,
  buildTaxOverrideOptions,
  buildHandoverTaxControls,
  buildCustomsTaxControls,
  buildHandoverDependencyData,
  buildCustomsDependencyData,
  renderHandoverWorkbench,
  renderCustomsWorkbench,
  buildDefaultInlandFormData,
  buildInlandFormData,
  buildInlandMapData,
  renderInlandWorkbench,
  renderWorkbench,
  renderAdminSettings,
  renderAdminRules,
  pickFromOptions,
  parseQuoteHeader,
  parseQuoteExtraFields,
  parseQuoteLineItems,
  parseQuotePullInputs,
  buildQuoteSelectorData,
  assembleQuoteView,
  selectQuoteNotes,
  buildQuoteFormData,
  renderQuoteWorkbench,
} = require("./lib/views");

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
