// POST /admin/:moduleKey/exchange-rates/refresh — manual FX refresh button +
// the in-app refresh-route monitor / min-interval guard (the "ghost" trap). Pure
// move from server.js — behavior unchanged.
//
// Public API: register(app, ctx) where ctx = { requireAuth, loadShippingData,
// baseView } (server.js helpers; will become module imports as the refactor
// proceeds). getBusinessModule + refreshMonitor are imported directly.

const refreshMonitor = require("../lib/refresh-monitor");
const { getBusinessModule } = require("../lib/modules");

function register(app, { requireAuth, loadShippingData, baseView }) {
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

      // Capture the request source (no secrets) so the external client that
      // hammers this route ~every 2s can be identified at /healthz, then stopped
      // at its origin. Our own frontend does not poll this route.
      refreshMonitor.record(refreshMonitor.describeRequest(req));

      // Defense-in-depth: when this route is hammered, short-circuit the refresh
      // (the FX throttle + read cache already make it cheap, but this caps the
      // work at the trigger regardless). The manual button is unaffected — a human
      // clicks far slower than the min-interval, and the settings page it
      // redirects to renders the current rates anyway.
      if (refreshMonitor.shouldThrottleRoute()) {
        refreshMonitor.noteSkipped();
      } else {
        refreshMonitor.markRefreshDone();
        // loadShippingData already persists refreshed rates via the targeted
        // jsonb_set (saveExchangeRates); no extra full-blob saveShippingData here
        // (that was redundant AND a data-clobber risk when this route is hammered).
        await loadShippingData({
          refreshRates: true,
          forceRefreshRates: true,
        });
      }
      req.session.flash = {
        type: "success",
        message: req.t("admin.exchangeRatesSaved"),
      };
      return res.redirect(`/admin/${module.key}/settings`);
    }
  );
}

module.exports = { register };
