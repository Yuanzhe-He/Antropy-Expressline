// GET /healthz — lightweight, unauthenticated health/usage endpoint. Exposes the
// in-memory usage-guard counters (today's app_state DB reads/writes vs thresholds,
// and whether an alert fired today) + the refresh-route monitor, so a storm can be
// seen live without trawling logs. No secrets, no DB hit. Pure move from server.js.
//
// Public API: register(app).

const usageGuard = require("../lib/usage-guard");
const refreshMonitor = require("../lib/refresh-monitor");

function register(app) {
  app.get("/healthz", (_req, res) => {
    return res.json({
      status: "ok",
      shippingCacheTtlMs: Number(process.env.SHIPPING_CACHE_TTL_MS) || 60 * 60 * 1000,
      usageGuard: usageGuard.getStatus(),
      refreshRoute: refreshMonitor.getStatus(),
    });
  });
}

module.exports = { register };
