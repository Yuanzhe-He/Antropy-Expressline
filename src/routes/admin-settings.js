// Admin settings routes: the /admin landing redirect and the per-module settings
// page (GET + POST). The POST also owns the quote remarks/notes library + quote
// number-format + header defaults (the quote branch). Pure move from server.js —
// route bodies are byte-for-byte the originals. server.js helpers arrive via ctx;
// lib functions are imported directly.
//
// Public API: register(app, ctx).

const { requireAuth } = require("../middleware/auth");
const { saveShippingData } = require("../lib/store");
const { DEFAULT_MODULE_KEY, getBusinessModule } = require("../lib/modules");
const { getModulePresentation } = require("../lib/i18n");
const { ensureArray, parseWholeNumber } = require("../lib/rule-engine");
const { buildTaxRatePresets } = require("../lib/handover-forms");
const {
  normalizeQuoteMode,
  QUOTE_DEPARTMENT_OPTIONS,
  QUOTE_TRANSPORT_MODE_OPTIONS,
  QUOTE_INCOTERM_OPTIONS,
  QUOTE_CARGO_TYPE_OPTIONS,
} = require("../lib/quote");

function register(app, ctx) {
  const {
    loadShippingData,
    getModuleData,
    baseView,
    redirectWithFlash,
    renderAdminSettings,
    pickFromOptions,
  } = ctx;

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
          headerOptions: {
            department: QUOTE_DEPARTMENT_OPTIONS,
            transportMode: QUOTE_TRANSPORT_MODE_OPTIONS,
            incoterm: QUOTE_INCOTERM_OPTIONS,
            cargoType: QUOTE_CARGO_TYPE_OPTIONS,
          },
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
      // S5: default header preset (validated against the option sets; empty clears).
      quote.settings.headerDefaults = {
        department: pickFromOptions(b.hd_department, QUOTE_DEPARTMENT_OPTIONS, ""),
        transportMode: pickFromOptions(b.hd_transportMode, QUOTE_TRANSPORT_MODE_OPTIONS, ""),
        incoterm: pickFromOptions(b.hd_incoterm, QUOTE_INCOTERM_OPTIONS, ""),
        cargoType: pickFromOptions(b.hd_cargoType, QUOTE_CARGO_TYPE_OPTIONS, ""),
        // S5: default quote mode for fresh quotes (mexico_only | ocean_mexico).
        quoteMode: normalizeQuoteMode(b.hd_quoteMode),
      };
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
}

module.exports = { register };
