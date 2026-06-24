// Container-type master admin routes (editable on the handover module, shared
// with customs): add / save / delete the container-type taxonomy. Pure move from
// server.js — route bodies are byte-for-byte the originals. server.js helpers
// arrive via ctx; lib functions are imported directly.
//
// Public API: register(app, ctx).

const { requireAuth } = require("../middleware/auth");
const { saveModule, RATE_GROUP_NAMES } = require("../lib/store");
const { countCustomsContainerReferences } = require("../lib/customs-rules");

function register(app, ctx) {
  const { loadShippingData, getModuleData, redirectWithFlash, baseView } = ctx;

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
      await saveModule("handover", shippingData);
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
      await saveModule("handover", shippingData);
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
      await saveModule("handover", shippingData);
      return redirectWithFlash(req, res, "success", req.t("containerTypes.deleted", { name: key }), target);
    }
  );
}

module.exports = { register };
