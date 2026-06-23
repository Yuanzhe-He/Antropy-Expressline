// Shipping-line admin routes (the /admin/:moduleKey/shipping-lines family,
// primarily the handover module): the list + edit pages, terminal-mix /
// local-charges / demurrage rule-set sub-resources, new-carrier add, line delete
// (cascading the customs mirror), and the big per-line edit handler (rate cells,
// tax, guarantee, terminal mix, demurrage + customs mirror sync). Pure move from
// server.js — route bodies are byte-for-byte the originals. server.js helpers
// arrive via ctx; lib functions are imported directly.
//
// Public API: register(app, ctx).

const { requireAuth } = require("../middleware/auth");
const { saveModule } = require("../lib/store");
const { parseNumber } = require("../lib/calculate");
const { getBusinessModule } = require("../lib/modules");
const {
  buildShippingLineDraft,
  buildSimpleShippingLineMirror,
  buildLocalChargeDraft,
  buildTerminalMixDraft,
  parsePercentRatio,
} = require("../lib/handover-forms");
const {
  buildRuleId,
  upsertRateCell,
  appendProgressiveRule,
  resequenceRules,
  removeProgressiveRule,
  applySequentialRuleUpdates,
} = require("../lib/rule-engine");

function register(app, ctx) {
  const {
    loadShippingData,
    getModuleData,
    redirectWithFlash,
    baseView,
    renderAdminRules,
  } = ctx;

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

    if (module.key === "quote") {
      return res.redirect("/workbench/quote");
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
    "/admin/:moduleKey/shipping-lines/:id/terminal-mix/add",
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
      const entry = buildTerminalMixDraft(updated, req.t);
      updated.terminalMix = [...(updated.terminalMix || []), entry];
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveModule("handover", shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.terminalMixAdded", { name: entry.terminal }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/terminal-mix/:mixId/delete",
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
      const beforeCount = updated.terminalMix?.length || 0;
      updated.terminalMix = (updated.terminalMix || []).filter(
        (entry) => entry.id !== req.params.mixId
      );
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveModule("handover", shippingData);

      return redirectWithFlash(
        req,
        res,
        beforeCount === updated.terminalMix.length ? "error" : "success",
        beforeCount === updated.terminalMix.length
          ? req.t("system.notFoundTitle")
          : req.t("admin.terminalMixDeleted"),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/local-charges/add",
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
      const charge = buildLocalChargeDraft(updated, moduleData, req.t);
      updated.localCharges = [...(updated.localCharges || []), charge];
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveModule("handover", shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.localChargeAdded", { name: charge.concept }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  // H1 (20260617): per-row delete for local charges (mirrors terminal-mix delete).
  app.post(
    "/admin/:moduleKey/shipping-lines/:id/local-charges/:chargeId/delete",
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
      const beforeCount = updated.localCharges?.length || 0;
      updated.localCharges = (updated.localCharges || []).filter(
        (entry) => entry.id !== req.params.chargeId
      );
      const removed = beforeCount !== updated.localCharges.length;
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveModule("handover", shippingData);

      return redirectWithFlash(
        req,
        res,
        removed ? "success" : "error",
        removed
          ? req.t("admin.localChargeDeleted")
          : req.t("system.notFoundTitle"),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/demurrage-rule-sets/add",
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
      // H4: harden against a missing demurrage block so "Agregar set" always works
      // (incl. a line that somehow has 0 rule sets — this bootstraps the first set).
      updated.demurrage = updated.demurrage || {};
      const ruleSets = updated.demurrage.ruleSets || [];
      const ruleSet = {
        id: buildRuleId(`demurrage-set-${updated.id}`),
        name: `${req.t("categories.demurrage")} ${ruleSets.length + 1}`,
        sourceGroupKey: null,
        rules: [],
      };
      appendProgressiveRule(ruleSet.rules, `${updated.id}-${ruleSet.id}`, ruleSet.name);
      resequenceRules(ruleSet.rules);
      ruleSets.push(ruleSet);
      updated.demurrage.ruleSets = ruleSets;
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveModule("handover", shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleAdded", { label: ruleSet.name }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/demurrage-rule-sets/:ruleSetId/add",
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
      const ruleSet = (updated.demurrage.ruleSets || []).find(
        (entry) => entry.id === req.params.ruleSetId
      );
      if (!ruleSet) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      appendProgressiveRule(
        ruleSet.rules,
        `${updated.id}-${ruleSet.id}`,
        ruleSet.name
      );
      resequenceRules(ruleSet.rules);
      if (ruleSet.sourceGroupKey) {
        // H4: guard rulesByGroup — a legacy set with sourceGroupKey but no
        // rulesByGroup map would otherwise throw on add-rule (a "加不了 demoras" path).
        updated.demurrage.rulesByGroup = updated.demurrage.rulesByGroup || {};
        updated.demurrage.rulesByGroup[ruleSet.sourceGroupKey] = ruleSet.rules;
      }
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveModule("handover", shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleAdded", { label: ruleSet.name }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  app.post(
    "/admin/:moduleKey/shipping-lines/:id/demurrage-rule-sets/:ruleSetId/:ruleId/delete",
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
      const ruleSet = (updated.demurrage.ruleSets || []).find(
        (entry) => entry.id === req.params.ruleSetId
      );
      if (!ruleSet) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      if (!removeProgressiveRule(ruleSet.rules, req.params.ruleId)) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("admin.cannotDeleteLastRule"),
          `/admin/${module.key}/shipping-lines/${updated.id}`
        );
      }

      resequenceRules(ruleSet.rules);
      if (ruleSet.sourceGroupKey) {
        updated.demurrage.rulesByGroup[ruleSet.sourceGroupKey] = ruleSet.rules;
      }
      shippingData.modules[module.key].shippingLines[lineIndex] = updated;
      await saveModule("handover", shippingData);
      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleDeleted", { label: ruleSet.name }),
        `/admin/${module.key}/shipping-lines/${updated.id}`
      );
    }
  );

  // D (round-r3): create a new carrier (handover only). MUST be registered
  // before POST .../:id so "add" is not captured as :id. Mirrors the ports/yards
  // "/add" pattern: build a minimal line (the store normalizer completes it) plus
  // a customs-side mirror, then jump to the edit page to fill the rest.
  app.post("/admin/:moduleKey/shipping-lines/add", requireAuth, async (req, res) => {
    const module = getBusinessModule(req.params.moduleKey);
    if (!module || module.key !== "handover") {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    const name = String(req.body.line_name || "").trim();
    if (!name) {
      return redirectWithFlash(
        req,
        res,
        "error",
        req.t("admin.lineNameRequired"),
        `/admin/${module.key}/shipping-lines`
      );
    }

    const shippingData = await loadShippingData({ refreshRates: false });
    const handover = getModuleData(shippingData, "handover");
    const line = buildShippingLineDraft(handover, {
      name,
      code: req.body.line_code,
      rfc: req.body.line_rfc,
    });
    handover.shippingLines = [...(handover.shippingLines || []), line];

    // Mirror into customs so the carrier is selectable in the yard↔line mapping
    // (customs.shippingLines is a separate list, not auto-synced from handover).
    const customs = getModuleData(shippingData, "customs");
    customs.shippingLines = [
      ...(customs.shippingLines || []),
      buildSimpleShippingLineMirror(line),
    ];

    await saveModule("handover", shippingData);

    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("admin.shippingLineAdded", { name: line.name }),
      `/admin/${module.key}/shipping-lines/${line.id}`
    );
  });

  // D (round-r3): delete a carrier (handover only) + cascade the customs mirror
  // and any yard↔line references.
  app.post(
    "/admin/:moduleKey/shipping-lines/:id/delete",
    requireAuth,
    async (req, res) => {
      const module = getBusinessModule(req.params.moduleKey);
      if (!module || module.key !== "handover") {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const shippingData = await loadShippingData({ refreshRates: false });
      const handover = getModuleData(shippingData, "handover");
      const line = (handover.shippingLines || []).find(
        (entry) => entry.id === req.params.id
      );
      if (!line) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const removedName = line.name;
      handover.shippingLines = handover.shippingLines.filter(
        (entry) => entry.id !== req.params.id
      );

      const customs = getModuleData(shippingData, "customs");
      customs.shippingLines = (customs.shippingLines || []).filter(
        (entry) => entry.id !== req.params.id
      );
      for (const yard of customs.yards || []) {
        yard.shippingLineIds = (yard.shippingLineIds || []).filter(
          (id) => id !== req.params.id
        );
      }

      await saveModule("handover", shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.shippingLineDeleted", { name: removedName }),
        `/admin/${module.key}/shipping-lines`
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
    // D (round-r3): name + carrier metadata (code = CODIGO DE NAVIERA, rfc = tax
    // id) are now editable. Empty name is ignored (keep the existing one).
    const editedName = String(req.body.line_name ?? "").trim();
    if (editedName) {
      updated.name = editedName;
    }
    updated.notes = {
      ...(updated.notes || {}),
      code: String(req.body.line_code ?? updated.notes?.code ?? "").trim() || null,
      rfc: String(req.body.line_rfc ?? updated.notes?.rfc ?? "").trim() || null,
    };
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
      const concept = String(
        req.body[`charge_concept_${charge.id}`] ?? charge.concept
      ).trim();
      if (concept) {
        charge.concept = concept;
      }
      charge.taxRate = parseNumber(req.body[`charge_tax_${charge.id}`], charge.taxRate);
      // H2/H3: BL + per-group cells are always editable now; upsert creates the
      // rate object when a value is entered into a previously-empty cell.
      upsertRateCell(charge, "blRate", req.body, `charge_bl_${charge.id}`);
      charge.groupRates = charge.groupRates || {};
      for (const group of updated.containerGroups || []) {
        upsertRateCell(
          charge.groupRates,
          group.key,
          req.body,
          `charge_${charge.id}_${group.key}`
        );
      }
    }

    updated.guarantee.ratesByGroup = updated.guarantee.ratesByGroup || {};
    for (const group of updated.containerGroups || []) {
      upsertRateCell(
        updated.guarantee.ratesByGroup,
        group.key,
        req.body,
        `guarantee_${group.key}`
      );
    }

    updated.terminalMix = (updated.terminalMix || [])
      .map((entry) => {
        const port = String(req.body[`terminal_mix_${entry.id}_port`] || entry.port || "")
          .trim();
        const terminal = String(
          req.body[`terminal_mix_${entry.id}_terminal`] || entry.terminal || ""
        ).trim();

        if (!port || !terminal) {
          return null;
        }

        return {
          ...entry,
          port,
          terminal,
          ratio: parsePercentRatio(
            req.body[`terminal_mix_${entry.id}_ratio`],
            entry.ratio
          ),
        };
      })
      .filter(Boolean);

    const validRuleSetIds = new Set((updated.demurrage.ruleSets || []).map((set) => set.id));
    updated.demurrage.assignmentsByContainerType = {};
    for (const type of moduleData.containerTypes || []) {
      const assignedRuleSetId = req.body[`demurrage_assignment_${type.key}`];
      updated.demurrage.assignmentsByContainerType[type.key] =
        validRuleSetIds.has(assignedRuleSetId)
          ? assignedRuleSetId
          : updated.demurrage.ruleSets?.[0]?.id || "";
    }

    updated.demurrage.freeDays.daysByGroup = {};
    for (const ruleSet of updated.demurrage.ruleSets || []) {
      ruleSet.name =
        req.body[`demurrage_set_${ruleSet.id}_name`] ||
        ruleSet.name ||
        ruleSet.id;
      const rules = ruleSet.rules || [];
      const updateResult = applySequentialRuleUpdates({
        rules,
        body: req.body,
        getPrefix: (rule) => `rule_set_${ruleSet.id}_${rule.id}`,
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

      ruleSet.rules = rules;
      if (ruleSet.sourceGroupKey) {
        updated.demurrage.rulesByGroup[ruleSet.sourceGroupKey] = rules;
      }

      for (const rule of rules) {
        if (rule.freeRule && rule.endDay) {
          updated.demurrage.freeDays.daysByGroup[ruleSet.id] = rule.endDay;
        }
      }
    }
    updated.demurrage.freeDays.defaultDays =
      Object.values(updated.demurrage.freeDays.daysByGroup)[0] || 0;

    shippingData.modules[module.key].shippingLines[lineIndex] = updated;

    // Keep the customs-side mirror's name/notes in sync (so the carrier label
    // matches in the yard↔line mapping). Only for handover carriers.
    if (module.key === "handover") {
      const customs = getModuleData(shippingData, "customs");
      const mirror = (customs.shippingLines || []).find(
        (entry) => entry.id === updated.id
      );
      if (mirror) {
        mirror.name = updated.name;
        mirror.notes = updated.notes ? { ...updated.notes } : null;
      }
    }

    await saveModule("handover", shippingData);
    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("admin.lineSaved", { name: updated.name }),
      `/admin/${module.key}/shipping-lines/${updated.id}`
    );
  });
}

module.exports = { register };
