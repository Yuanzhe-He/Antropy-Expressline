// Composition root. createApp() wires Express + middleware + the route modules
// and returns the app; the bottom guard starts the HTTP listener + FX scheduler.
// All behavior lives in ./routes/* (HTTP), ./lib/* (logic/view), ./lib/store
// (data). Single dependency direction: routes -> lib -> store -> db.

const express = require("express");
const session = require("express-session");
const path = require("node:path");

const usageGuard = require("./lib/usage-guard");
const { startExchangeRateScheduler } = require("./lib/exchange-rate-scheduler");
const { attachUser, requireAuth } = require("./middleware/auth");
const { languageMiddleware } = require("./middleware/i18n");
const { safeJsonLocals, flashMiddleware } = require("./middleware/locals");
const { buildRuleId } = require("./lib/rule-engine");
const { buildHandoverFormData } = require("./lib/handover-forms");
const views = require("./lib/views");

const coreRoutes = require("./routes/core");
const healthRoutes = require("./routes/health");
const exchangeRatesRoutes = require("./routes/exchange-rates");
const workbenchRoutes = require("./routes/workbench");
const adminInlandRoutes = require("./routes/admin-inland");
const adminCustomsRoutes = require("./routes/admin-customs");
const adminShippingLinesRoutes = require("./routes/admin-shipping-lines");
const adminHandoverRoutes = require("./routes/admin-handover");
const adminSettingsRoutes = require("./routes/admin-settings");

const port = process.env.PORT || 3000;
const sessionSecret =
  process.env.SESSION_SECRET || "jose-expressline-consulting-local";

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

  // Middleware order is behavior-sensitive — keep this exact sequence:
  // language → user → safeJson locals → flash. (Extracted to ./middleware/*.)
  app.use(languageMiddleware);
  app.use(attachUser);
  app.use(safeJsonLocals);
  app.use(flashMiddleware);

  // Shared route context: the view / render / form-data layer (./lib/views) plus
  // the few non-view helpers a route module still needs. Each route module
  // destructures the subset it uses (the workbench `register(app, ctx)` pattern,
  // unified into one container).
  const ctx = { ...views, buildRuleId, buildHandoverFormData, requireAuth };

  // Registration order is matching-sensitive: the customs-specific
  // /admin/customs/shipping-lines routes must register before the generic
  // /admin/:moduleKey/shipping-lines routes. This sequence matches the original.
  coreRoutes.register(app); // /, /login, /logout, /preferences/language
  healthRoutes.register(app); // GET /healthz
  workbenchRoutes.register(app, ctx);
  adminInlandRoutes.register(app, ctx);
  adminSettingsRoutes.register(app, ctx);
  exchangeRatesRoutes.register(app, ctx); // POST /admin/:moduleKey/exchange-rates/refresh
  adminHandoverRoutes.register(app, ctx);
  adminCustomsRoutes.register(app, ctx);
  adminShippingLinesRoutes.register(app, ctx);

  app.use((req, res) => {
    res.status(404).render(
      "not-found",
      views.baseView(req, {
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
