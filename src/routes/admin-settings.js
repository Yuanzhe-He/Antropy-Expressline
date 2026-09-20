// Admin settings routes: the /admin landing redirect and the per-module settings
// page (GET + POST). The POST also owns the quote remarks/notes library + quote
// number-format + header defaults (the quote branch). Pure move from server.js —
// route bodies are byte-for-byte the originals. server.js helpers arrive via ctx;
// lib functions are imported directly.
//
// Public API: register(app, ctx).

const { requireAuth } = require("../middleware/auth");
const { saveModule } = require("../lib/store");
const { DEFAULT_MODULE_KEY, getBusinessModule } = require("../lib/modules");
const { getModulePresentation } = require("../lib/i18n");
const { ensureArray, parseWholeNumber } = require("../lib/rule-engine");
const { buildTaxRatePresets } = require("../lib/handover-forms");
const {
  normalizeQuoteMode,
  QUOTE_DEPARTMENT_OPTIONS,
  QUOTE_TRANSPORT_MODE_OPTIONS,
  QUOTE_INCOTERM_OPTIONS,
  normalizeQuoteCargoTypes,
  normalizeQuoteCargoCode,
  validateQuoteCargoTypes,
  QUOTE_UOM_OPTIONS,
} = require("../lib/quote");
const {
  QUOTE_FEE_CATEGORIES,
  getQuoteDefaultCurrency,
  normalizeQuoteFeeTemplates,
  validateQuoteFeeTemplates,
  normalizeCargoPricingRules,
  validateCargoPricingRules,
} = require("../lib/quote-config");

const FEE_FORM_FIELDS = ["id", "chargeKind", "category", "section", "en", "zh", "es", "unit", "uom", "price", "max", "currency", "remark", "active", "modes", "selectionRequired", "sourceNote"];

function quoteConfigErrorMessage(code, language) {
  const messages = {
    invalid_currency_defaults: ["请为每个费用分组选择 USD 或 MXN，不能重复或遗漏分组。", "Selecciona USD o MXN para cada grupo, sin grupos duplicados ni faltantes."],
    invalid_fee_templates: ["费用表单不完整，或超过 100 项。请检查后重试。", "La lista está incompleta o supera 100 cargos. Revisa los datos."],
    invalid_fee_template: ["费用内容无效，请检查后重试。", "El cargo contiene datos no válidos."],
    invalid_fee_template_id: ["费用编号只能包含字母、数字、下划线和连字符，最长 80 字符。", "El identificador admite letras, números, guiones y guiones bajos; máximo 80 caracteres."],
    duplicate_fee_template_id: ["费用编号重复，请为新增费用使用不同编号。", "Hay identificadores de cargo duplicados."],
    invalid_fee_template_code: ["官方费用代码最多 100 字符，不能包含换行或控制字符；尚未确认可留空。", "El código oficial admite hasta 100 caracteres, sin saltos de línea ni caracteres de control; puede quedar vacío."],
    invalid_fee_template_label: ["每项费用至少填写中文或英文名称，每个名称最多 200 字符。", "Cada cargo requiere un nombre chino o inglés de hasta 200 caracteres."],
    invalid_fee_template_category: ["请选择有效的费用分组。", "Selecciona un grupo de cargos válido."],
    invalid_fee_template_currency: ["费用币种只能为 USD 或 MXN。", "La moneda del cargo debe ser USD o MXN."],
    invalid_fee_template_charge_kind: ["请选择固定费用或发生才收费用。", "Selecciona cargo fijo o cargo si ocurre."],
    invalid_fee_template_section: ["请选择墨西哥段或非墨西哥段。", "Selecciona la sección México o fuera de México."],
    invalid_fee_template_enabled: ["请选择费用的启用状态。", "Selecciona el estado del cargo."],
    invalid_fee_template_selection: ["请选择报价时的添加方式。", "Selecciona cómo se agrega el cargo a la cotización."],
    invalid_fee_template_cargo_types: ["适用装载方式至少选择一种：FCL、LCL、BBK 或 AIR。", "Selecciona al menos un tipo: FCL, LCL, BBK o AIR."],
    invalid_cargo_pricing_rules: ["计费规则不完整，请检查 LCL、BBK、AIR 三项后重试。", "Completa las reglas de LCL, BBK y AIR."],
    invalid_cargo_pricing_method: ["请选择有效的计费方式：原始数值较大者、体积重或手动。", "Selecciona máximo numérico, peso volumétrico o manual."],
    invalid_cargo_pricing_divisor: ["体积系数必须为大于 0 的数字；选择体积重计费时必须填写。", "El divisor debe ser un número mayor que 0 y es obligatorio al usar peso volumétrico."],
    invalid_fee_template_price: ["价格必须是非负数字，也可以留空。", "El precio debe ser un número no negativo o quedar vacío."],
    invalid_fee_template_price_range: ["价格上限必须是非负数字，并且不低于下限；单一价格请留空上限。", "El precio máximo debe ser numérico y no menor que el mínimo; déjalo vacío para un precio único."],
    invalid_fee_template_quantity: ["默认数量必须是非负数字，也可以留空。", "La cantidad predeterminada debe ser un número no negativo o quedar vacía."],
    invalid_fee_template_unit: ["计费单位最多 40 字符。", "La unidad admite hasta 40 caracteres."],
    invalid_fee_template_remark: ["费用说明最多 3,000 字符。", "La descripción admite hasta 3,000 caracteres."],
    invalid_fee_template_source: ["内部来源备注最多 2,000 字符。", "La referencia interna admite hasta 2,000 caracteres."],
  };
  return (messages[code] || messages.invalid_fee_template)[language === "es" ? 1 : 0];
}

function register(app, ctx) {
  const {
    loadShippingData,
    getModuleData,
    baseView,
    redirectWithFlash,
    renderAdminSettings,
    pickFromOptions,
  } = ctx;

  function renderQuoteSettings(req, res, quote, overrides = {}) {
    const moduleMeta = getModulePresentation("quote", req.language);
    // A rejected blank name must not erase the user's default selection while
    // they correct the row. This fallback is for the unsaved editor only.
    const cargoOptions = overrides.cargoError
      ? quote.settings.cargoTypes.map((entry) => ({ ...entry, label: entry.label || entry.code }))
      : quote.settings.cargoTypes;
    return res.render("admin-quote", baseView(req, {
      pageTitle: `${moduleMeta.title} | ${req.t("app.name")}`,
      currentArea: "admin",
      currentModuleKey: "quote",
      currentAdminSection: "settings",
      selectedModule: moduleMeta,
      quoteSettings: quote.settings,
      quoteNotes: quote.notes || [],
      feeCategories: QUOTE_FEE_CATEGORIES,
      feeUomOptions: QUOTE_UOM_OPTIONS,
      feeError: "",
      feeErrorCode: "",
      currencyError: "",
      cargoPricingRules: normalizeCargoPricingRules(quote.settings.cargoPricingRules),
      cargoPricingError: "",
      headerOptions: {
        department: QUOTE_DEPARTMENT_OPTIONS,
        transportMode: QUOTE_TRANSPORT_MODE_OPTIONS,
        incoterm: QUOTE_INCOTERM_OPTIONS,
        cargoType: normalizeQuoteCargoTypes(cargoOptions).filter((entry) => entry.enabled),
      },
      languageReturnTo: req.originalUrl,
      ...overrides,
    }));
  }

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
      return renderQuoteSettings(req, res, quote);
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
      const storedCargoCodes = normalizeQuoteCargoTypes(quote.settings.cargoTypes).map((entry) => entry.code);
      let cargoError = "";
      let feeError = "";
      let currencyError = "";
      let cargoPricingError = "";
      let postedCargoPricingRules;
      let postedCurrencyRows;
      if (b.cargoPricingRulesPresent === "1") {
        const types = ensureArray(b.pricing_type);
        const methods = ensureArray(b.pricing_method);
        const divisors = ensureArray(b.pricing_divisor);
        const knownTypes = ["LCL", "BBK", "AIR"];
        const complete = types.length === knownTypes.length && new Set(types).size === types.length &&
          types.every((type) => knownTypes.includes(type)) && methods.length === types.length && divisors.length === types.length &&
          [...methods, ...divisors].every((value) => typeof value === "string");
        postedCargoPricingRules = Object.fromEntries(knownTypes.map((type) => {
          const index = types.indexOf(type);
          return [type, {
            method: typeof methods[index] === "string" ? methods[index].trim() : "",
            volumeDivisor: typeof divisors[index] === "string" ? divisors[index].trim() : "",
          }];
        }));
        cargoPricingError = complete ? validateCargoPricingRules(postedCargoPricingRules) : "invalid_cargo_pricing_rules";
        if (!cargoPricingError) quote.settings.cargoPricingRules = normalizeCargoPricingRules(postedCargoPricingRules);
      }
      if (b.currencyDefaultsPresent === "1") {
        const categories = ensureArray(b.currency_category);
        const values = ensureArray(b.currency_value);
        postedCurrencyRows = categories.map((category, index) => ({
          category: typeof category === "string" ? category : "",
          value: typeof values[index] === "string" ? values[index] : "",
        }));
        if (categories.length !== QUOTE_FEE_CATEGORIES.length || categories.length !== values.length ||
          new Set(categories).size !== categories.length || categories.some((category) => !QUOTE_FEE_CATEGORIES.includes(category)) ||
          values.some((value) => !["USD", "MXN"].includes(value))) {
          currencyError = "invalid_currency_defaults";
        } else {
          quote.settings.defaultCurrencyByCategory = Object.fromEntries(postedCurrencyRows.map((row) => [row.category, row.value]));
        }
      }
      if (b.feeTemplatesPresent === "1") {
        const fields = Object.fromEntries(FEE_FORM_FIELDS.map((field) => [field, ensureArray(b[`fee_${field}`])]));
        // An older form may omit official codes entirely. Keep its saved codes;
        // current forms submit blank explicitly when a code is not yet known.
        const codes = b.fee_code === undefined ? null : ensureArray(b.fee_code);
        const previous = new Map((quote.settings.feeTemplates || []).map((entry) => [entry.id, entry]));
        const text = (field, index) => typeof fields[field][index] === "string" ? fields[field][index].trim() : "";
        const rows = fields.id.map((_id, index) => {
          const id = text("id", index);
          const category = text("category", index);
          const stored = previous.get(id) || {};
          // Explicit submitted currencies always win. The category default is
          // used only for an empty currency, never to reprice existing rows.
          const currency = text("currency", index) || getQuoteDefaultCurrency(category, quote.settings);
          return {
            ...stored,
            id, category, currency,
            code: codes ? codes[index] : (stored.code || ""),
            chargeKind: text("chargeKind", index), section: text("section", index),
            conceptEn: text("en", index), conceptZh: text("zh", index), conceptEs: text("es", index),
            unit: text("unit", index), defaultQuantity: text("unit", index), unitOfMeasure: text("uom", index),
            unitPrice: text("price", index), unitPriceMax: text("max", index),
            remark: text("remark", index), sourceNote: text("sourceNote", index),
            enabled: text("active", index) === "1", selectionRequired: text("selectionRequired", index) === "1",
            editorActiveValue: text("active", index), editorSelectionValue: text("selectionRequired", index),
            appliesTo: text("modes", index).split(",").map((value) => value.trim()).filter(Boolean),
          };
        });
        feeError = validateQuoteFeeTemplates(rows);
        if ((codes && (codes.length !== fields.id.length || codes.some((value) => typeof value !== "string"))) || FEE_FORM_FIELDS.some((field) => fields[field].length !== fields.id.length || fields[field].some((value) => typeof value !== "string"))) {
          feeError = "invalid_fee_templates";
        } else if (fields.active.some((value) => !["0", "1"].includes(value))) {
          feeError = "invalid_fee_template_enabled";
        } else if (fields.selectionRequired.some((value) => !["0", "1"].includes(value))) {
          feeError = "invalid_fee_template_selection";
        } else if (fields.section.some((value) => !["mexico", "foreign"].includes(value))) {
          feeError = "invalid_fee_template_section";
        }
        quote.settings.feeTemplates = feeError ? rows : normalizeQuoteFeeTemplates(rows);
      }
      if (b.cargoTypesPresent === "1") {
        const codes = ensureArray(b.cargo_code);
        const labels = ensureArray(b.cargo_label);
        const enabled = ensureArray(b.cargo_enabled);
        const cargoTypes = codes.map((code, index) => ({
          code: typeof code === "string" ? code.trim() : "",
          label: typeof labels[index] === "string" ? labels[index].trim() : "",
          enabled: enabled[index] === "1",
        }));
        cargoError = validateQuoteCargoTypes(cargoTypes);
        if (codes.length !== labels.length || codes.length !== enabled.length || enabled.some((value) => !["0", "1"].includes(value))) {
          cargoError = "invalid_cargo_types";
        }
        quote.settings.cargoTypes = cargoError ? cargoTypes : normalizeQuoteCargoTypes(cargoTypes);
      }
      if (typeof b.quoteNumberPrefix === "string") quote.settings.quoteNumberPrefix = b.quoteNumberPrefix.trim();
      if (typeof b.quoteNumberSuffix === "string") quote.settings.quoteNumberSuffix = b.quoteNumberSuffix.trim();
      if (b.quoteNumberPad !== undefined) quote.settings.quoteNumberPad = Math.max(1, Math.min(8, parseWholeNumber(b.quoteNumberPad, 3) || 3));
      if (b.lastQuoteSeq !== undefined) quote.settings.lastQuoteSeq = Math.max(0, parseWholeNumber(b.lastQuoteSeq, 0));
      // S5: default header preset (validated against the option sets; empty clears).
      const hd = quote.settings.headerDefaults || {};
      const enabledCargoCodes = cargoError
        ? quote.settings.cargoTypes.filter((entry) => entry.enabled).map((entry) => normalizeQuoteCargoCode(entry.code)).filter(Boolean)
        : normalizeQuoteCargoTypes(quote.settings.cargoTypes).filter((entry) => entry.enabled).map((entry) => entry.code);
      quote.settings.headerDefaults = {
        department: pickFromOptions(b.hd_department ?? hd.department, QUOTE_DEPARTMENT_OPTIONS, ""),
        transportMode: pickFromOptions(b.hd_transportMode ?? hd.transportMode, QUOTE_TRANSPORT_MODE_OPTIONS, ""),
        incoterm: pickFromOptions(b.hd_incoterm ?? hd.incoterm, QUOTE_INCOTERM_OPTIONS, ""),
        cargoType: pickFromOptions(b.hd_cargoType ?? hd.cargoType, enabledCargoCodes, ""),
        quoteMode: normalizeQuoteMode(b.hd_quoteMode ?? hd.quoteMode),
      };
      const ids = ensureArray(b.note_id);
      const ens = ensureArray(b.note_en);
      const zhs = ensureArray(b.note_zh);
      const ess = ensureArray(b.note_es);
      if (b.notesPresent === "1" || b.note_id !== undefined) quote.notes = ids
        .map((id, i) => ({
          id: String(id || `note-${i + 1}`),
          en: String(ens[i] || "").trim(),
          es: String(ess[i] || "").trim(),
          zh: String(zhs[i] || "").trim(),
        }))
        .filter((n) => n.en || n.zh || n.es);
      if (cargoError || feeError || currencyError || cargoPricingError) {
        res.status(400);
        return renderQuoteSettings(req, res, quote, {
          cargoError: cargoError ? req.t(`quote.${cargoError}`) : "",
          feeError: feeError ? quoteConfigErrorMessage(feeError, req.language) : "",
          feeErrorCode: feeError,
          currencyError: currencyError ? quoteConfigErrorMessage(currencyError, req.language) : "",
          cargoPricingError: cargoPricingError ? quoteConfigErrorMessage(cargoPricingError, req.language) : "",
          ...(cargoPricingError ? { cargoPricingRules: postedCargoPricingRules } : {}),
          postedCurrencyRows,
          storedCargoCodes,
        });
      }
      shippingData.modules.quote = quote;
      await saveModule("quote", shippingData);
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

    await saveModule(module.key, shippingData);
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
