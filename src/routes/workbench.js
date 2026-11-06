// Workbench (sales/operator) routes: the per-module calculators + the quote
// builder/PDF. Pure move from server.js — route bodies are byte-for-byte the
// originals. Lib functions are imported directly; server.js helpers arrive via
// ctx (they will become module imports as the refactor proceeds).
//
// Public API: register(app, ctx).

const {
  computeCalculator,
  computeCustomsCalculator,
  computeInlandCalculator,
} = require("../lib/calculate");
const { getBusinessModule } = require("../lib/modules");
const { saveModule } = require("../lib/store");
const {
  pullCalculatorValues,
  loadFeeCodes,
  QUOTE_CARGO_TYPE_OPTIONS,
} = require("../lib/quote");
const { renderQuotePdf } = require("../lib/quote-pdf");
const { normalizeQuoteType, normalizeRateCardsByType, validateRateCard } = require("../../public/quote-rate-card");
const { shouldUseDatabase, insertQuoteSnapshot } = require("../lib/db");
const { buildQuoteFilename, resolveQuoteNumber, validateQuoteNaming } = require("../lib/quote-export");

// Serialize quote read/allocate/save within this app process. Sequence numbers
// remain persisted in the existing quote settings. This is not a distributed
// lock; multiple application writers need a DB-backed allocator.
let quoteWriteQueue = Promise.resolve();
function serializeQuoteMutation(handler) {
  return (req, res, next) => {
    const task = quoteWriteQueue.then(() => handler(req, res));
    quoteWriteQueue = task.catch(() => {});
    return task.catch(next);
  };
}

function updateQuoteDraft(quoteModule, formData, numberDecision) {
  const now = new Date().toISOString();
  const existing = numberDecision.existing;
  const saved = {
    id: existing?.id || require("node:crypto").randomUUID(),
    number: formData.number, date: formData.date, header: formData.header,
    quoteMode: formData.quoteMode, lineItems: formData.lineItems,
    noteIds: formData.noteIds, language: formData.language,
    createdAt: existing?.createdAt || now, updatedAt: now,
  };
  quoteModule.drafts = existing
    ? (quoteModule.drafts || []).map((entry) => entry.id === existing.id ? saved : entry)
    : [...(quoteModule.drafts || []), saved];
  formData.draftId = saved.id;
  if (numberDecision.advanceTo !== null) quoteModule.settings.lastQuoteSeq = numberDecision.advanceTo;
}

const { requireAuth } = require("../middleware/auth");

function register(app, ctx) {
  const {
    baseView,
    loadShippingData,
    getModuleData,
    redirectWithFlash,
    renderWorkbench,
    renderQuoteWorkbench,
    rememberCalculatorState,
    rememberLinkedWorkflow,
    getSelectedLine,
    buildHandoverFormData,
    buildDefaultHandoverFormData,
    buildCustomsFormData,
    buildDefaultCustomsFormData,
    resolveCustomsSelections,
    buildInlandFormData,
    buildDefaultInlandFormData,
    buildQuoteFormData,
    assembleQuoteView,
    buildQuoteSelectorData,
  } = ctx;

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
      const draft = typeof req.query.draft === "string"
        ? (quoteModule.drafts || []).find((entry) => entry.id === req.query.draft) : null;
      const formData = draft ? {
        ...draft,
        draftId: draft.id,
        cargoPricing: draft.header.cargoPricing || {},
        cargoPricingByType: draft.header.cargoPricingByType || (QUOTE_CARGO_TYPE_OPTIONS.includes(draft.header.cargoType) && draft.header.cargoPricing ? { [draft.header.cargoType]: draft.header.cargoPricing } : {}),
        quoteType: normalizeQuoteType(draft.header.quoteType),
        rateCardsByType: normalizeRateCardsByType(draft.header.rateCardsByType),
        showTotals: draft.header.showTotals === true,
        outputAudience: draft.header.outputAudience || "customer",
        taxTreatment: draft.header.taxTreatment || "unspecified",
        includeStamp: draft.header.includeStamp === true,
        customerCode: draft.header.customerCode || "",
        salesCode: draft.header.salesCode || "",
        revision: draft.header.revision || 1,
        noteIds: draft.header.notesSelectionExplicit || draft.noteIds?.length
          ? draft.noteIds : (quoteModule.notes || []).map((note) => note.id),
        pullInputs: {},
      } : buildQuoteFormData(quoteModule, {});
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

  function quoteError(req, res, quoteModule, formData, shippingData, message) {
    req.flash = { type: "error", message };
    res.status(400);
    return renderQuoteWorkbench(req, res, { moduleKey: "quote", quoteModule, formData,
      quoteView: assembleQuoteView(quoteModule, formData, shippingData),
      selectorData: buildQuoteSelectorData(shippingData), feeCodes: loadFeeCodes() });
  }

  app.post("/workbench/quote", requireAuth, serializeQuoteMutation(async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const quoteModule = getModuleData(shippingData, "quote");
    const formData = buildQuoteFormData(quoteModule, req.body);
    const action = req.body.action || "recompute";
    if (validateQuoteNaming(formData.header).length) return quoteError(req, res, quoteModule, formData, shippingData,
      req.language === "es" ? "Completa ambos códigos (letras, números, guiones; máximo 40) y una versión entera de 1 a 9999, o deja ambos códigos vacíos." : "客户和报价人 code 请同时填写（字母、数字、下划线或连字符，最多 40 位），也可同时留空；版本必须为 1–9999 的整数。");
    if (formData.quoteType === "long_term") {
      const cardMap = formData.rateCardsByType || {};
      const card = cardMap[formData.header.cargoType];
      const errors = [...(cardMap._validationErrors || []), ...(card ? validateRateCard(card) : [])];
      if (errors.length) {
        req.flash = { type: "error", message: req.language === "es" ? "Revisa las especificaciones y los precios del tarifario antes de guardar." : "请检查长期报价的规格、币种、单价和区间，再保存。" };
        res.status(400);
        return renderQuoteWorkbench(req, res, { moduleKey: "quote", quoteModule, formData,
          quoteView: assembleQuoteView(quoteModule, formData, shippingData),
          selectorData: buildQuoteSelectorData(shippingData), feeCodes: loadFeeCodes() });
      }
    }

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
      const numberDecision = resolveQuoteNumber(quoteModule, formData, req.body);
      if (numberDecision.error) return quoteError(req, res, quoteModule, formData, shippingData,
        req.language === "es" ? "El número ya pertenece a otra cotización. Usa otro número o abre el borrador existente." : "此报价编号已被另一份报价使用，请更换编号或打开已有草稿。");
      formData.number = numberDecision.number;
      updateQuoteDraft(quoteModule, formData, numberDecision);
      await saveModule("quote", shippingData);
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
  }));

  app.post("/workbench/quote/pdf", requireAuth, serializeQuoteMutation(async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const quoteModule = getModuleData(shippingData, "quote");
    const formData = buildQuoteFormData(quoteModule, req.body);

    if (validateQuoteNaming(formData.header).length) return quoteError(req, res, quoteModule, formData, shippingData,
      req.language === "es" ? "Completa ambos códigos válidos y una versión entera de 1 a 9999, o deja ambos códigos vacíos." : "客户和报价人 code 请同时填写且只使用字母、数字、下划线或连字符；版本必须为 1–9999 的整数。旧报价可同时留空 code。");
    const numberDecision = resolveQuoteNumber(quoteModule, formData, req.body);
    if (numberDecision.error) return quoteError(req, res, quoteModule, formData, shippingData,
      req.language === "es" ? "El número ya pertenece a otra cotización. Abre su borrador o cambia el número." : "此报价编号已被另一份报价使用，请打开已有草稿或更换编号。");
    formData.number = numberDecision.number;

    const quoteView = assembleQuoteView(quoteModule, formData, shippingData);

    if (quoteView.quoteType === "long_term" && quoteView.rateCard.errors.length) {
      req.flash = { type: "error", message: req.language === "es"
        ? "Selecciona un tipo de carga y captura al menos una tarifa válida. Revisa las especificaciones, monedas y rangos."
        : "请选择装载方式，并填写至少一项有效的长期单价；检查规格名称、币种和价格区间。" };
      res.status(400);
      return renderQuoteWorkbench(req, res, { moduleKey: "quote", quoteModule, formData, quoteView,
        selectorData: buildQuoteSelectorData(shippingData), feeCodes: loadFeeCodes() });
    }

    if (quoteView.pricingErrors.length) return quoteError(req, res, quoteModule, formData, shippingData,
      req.language === "es" ? "Revisa los porcentajes, valores de mercancía y tipos de precio. Un porcentaje no puede combinarse con AT COST o un rango." : "请检查费率、货值及计价方式；百分比不能同时使用 AT COST 或金额区间，负数及无效输入不能导出。");

    // Drafts may retain incomplete inputs; a priced PDF must have a complete,
    // server-validated calculation for the currently selected loading mode.
    if (quoteView.cargoCalculation.attempted && !quoteView.cargoCalculation.valid) {
      req.flash = {
        type: "error",
        message: req.language === "es"
          ? "Complete los datos de carga y use cantidades, pesos, medidas y tarifas válidos antes de generar el PDF."
          : "请补全当前装载方式的计价信息，并检查箱量、包装数量、尺寸、重量及单价后再生成 PDF。",
      };
      res.status(400);
      return renderQuoteWorkbench(req, res, {
        moduleKey: "quote", quoteModule, formData, quoteView,
        selectorData: buildQuoteSelectorData(shippingData), feeCodes: loadFeeCodes(),
      });
    }

    try {
      const pdf = await renderQuotePdf(quoteView);

      // Preserve editor identity and metadata for stable re-export/revision.
      updateQuoteDraft(quoteModule, formData, numberDecision);
      await saveModule("quote", shippingData);

      if (shouldUseDatabase()) {
        try {
          await insertQuoteSnapshot({
            moduleKey: "quote",
            businessNature: quoteView.header.operation,
            input: {
              number: formData.number,
              header: formData.header,
              quoteMode: formData.quoteMode,
              language: formData.language,
              noteIds: formData.noteIds,
              lineItems: formData.lineItems,
            },
            result: {
              rows: quoteView.rows,
              subtotals: quoteView.subtotals,
              indicative: quoteView.indicative,
              showTotals: quoteView.showTotals,
              outputAudience: quoteView.outputAudience,
              taxTreatment: quoteView.taxTreatment,
              quoteType: quoteView.quoteType,
              rateCard: quoteView.rateCard,
            },
          });
        } catch (snapshotError) {
          console.error("quote snapshot failed", snapshotError);
        }
      }

      const filename = buildQuoteFilename(formData, quoteModule.settings);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(pdf);
    } catch (error) {
      console.error("quote pdf generation failed", error);
      return redirectWithFlash(req, res, "error", req.t("quote.pdfError"), "/workbench/quote");
    }
  }));
}

module.exports = { register };
