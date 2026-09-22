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
  generateQuoteNumber,
  loadFeeCodes,
  QUOTE_CARGO_TYPE_OPTIONS,
} = require("../lib/quote");
const { renderQuotePdf } = require("../lib/quote-pdf");
const { normalizeQuoteType, normalizeRateCardsByType, validateRateCard } = require("../../public/quote-rate-card");
const { shouldUseDatabase, insertQuoteSnapshot } = require("../lib/db");
const { requireAuth } = require("../middleware/auth");

function register(app, ctx) {
  const {
    baseView,
    loadShippingData,
    getModuleData,
    redirectWithFlash,
    buildRuleId,
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

  app.post("/workbench/quote", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const quoteModule = getModuleData(shippingData, "quote");
    const formData = buildQuoteFormData(quoteModule, req.body);
    const action = req.body.action || "recompute";
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
      const provided = (req.body.quotationNumber || "").trim();
      let advanceTo = null;
      if (provided) {
        formData.number = provided;
      } else {
        const generated = generateQuoteNumber(quoteModule.settings);
        formData.number = generated.number;
        advanceTo = generated.nextSeq;
      }
      const now = new Date().toISOString();
      const existingDraft = (quoteModule.drafts || []).find((entry) => entry.id === formData.draftId);
      const savedDraft = {
          id: existingDraft?.id || buildRuleId("quote"),
          number: formData.number,
          date: formData.date,
          header: formData.header,
          quoteMode: formData.quoteMode,
          lineItems: formData.lineItems,
          // S2/Q7: persist the ordered remark selection + output language.
          noteIds: formData.noteIds,
          language: formData.language,
          createdAt: existingDraft?.createdAt || now,
          updatedAt: now,
      };
      quoteModule.drafts = existingDraft
        ? quoteModule.drafts.map((entry) => entry.id === existingDraft.id ? savedDraft : entry)
        : [...(quoteModule.drafts || []), savedDraft];
      formData.draftId = savedDraft.id;
      if (advanceTo !== null) {
        quoteModule.settings.lastQuoteSeq = advanceTo;
      }
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
  });

  app.post("/workbench/quote/pdf", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const quoteModule = getModuleData(shippingData, "quote");
    const formData = buildQuoteFormData(quoteModule, req.body);

    const provided = (req.body.quotationNumber || "").trim();
    let advanceTo = null;
    if (provided) {
      formData.number = provided;
    } else {
      const generated = generateQuoteNumber(quoteModule.settings);
      formData.number = generated.number;
      advanceTo = generated.nextSeq;
    }

    const quoteView = assembleQuoteView(quoteModule, formData, shippingData);

    if (quoteView.quoteType === "long_term" && quoteView.rateCard.errors.length) {
      req.flash = { type: "error", message: req.language === "es"
        ? "Selecciona un tipo de carga y captura al menos una tarifa válida. Revisa las especificaciones, monedas y rangos."
        : "请选择装载方式，并填写至少一项有效的长期单价；检查规格名称、币种和价格区间。" };
      res.status(400);
      return renderQuoteWorkbench(req, res, { moduleKey: "quote", quoteModule, formData, quoteView,
        selectorData: buildQuoteSelectorData(shippingData), feeCodes: loadFeeCodes() });
    }

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

      if (advanceTo !== null) {
        quoteModule.settings.lastQuoteSeq = advanceTo;
        await saveModule("quote", shippingData);
      }

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

      const safeName = String(formData.number || "quote").replace(/[^A-Za-z0-9._-]+/g, "_");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}${quoteView.quoteType === "long_term" ? "-rate-card" : ""}${quoteView.outputAudience === "internal" ? "-internal" : ""}.pdf"`);
      return res.send(pdf);
    } catch (error) {
      console.error("quote pdf generation failed", error);
      return redirectWithFlash(req, res, "error", req.t("quote.pdfError"), "/workbench/quote");
    }
  });
}

module.exports = { register };
