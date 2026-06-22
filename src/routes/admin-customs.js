// Customs admin routes: ports / terminals / yards CRUD, terminal fixed charges,
// the storage rule-set progressive engine (add/add-rule/delete-rule/delete-set +
// per-container path), storage assignment release, and the bulk "save all customs
// rules" handler. Pure move from server.js — route bodies are byte-for-byte the
// originals. The removeCustomsStorageAssignment closure moves with the routes.
// server.js helpers arrive via ctx; lib functions are imported directly.
//
// Public API: register(app, ctx).

const { requireAuth } = require("../middleware/auth");
const { saveShippingData } = require("../lib/store");
const { parseNumber } = require("../lib/calculate");
const {
  findCustomsTerminal,
  buildCustomsPortDraft,
  buildCustomsTerminalDraft,
  buildCustomsStorageRuleSetDraft,
  findAssignedStorageRuleSet,
  syncTerminalStorageRulesByContainer,
  buildCustomsYardDraft,
} = require("../lib/customs-rules");
const {
  ensureArray,
  uniqueIds,
  buildRuleId,
  buildZeroRatesByContainer,
  getLineContainerAssignmentKey,
  applyRateCellUpdates,
  appendProgressiveRule,
  resequenceRules,
  removeProgressiveRule,
  unassignStorageRuleSetAssignments,
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

  app.get("/admin/customs/shipping-lines", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData();
    return renderAdminRules(req, res, {
      moduleKey: "customs",
      moduleData: getModuleData(shippingData, "customs"),
    });
  });

  // O1 (20260617): defensive GET handlers for /admin/customs/ports/:id and
  // /admin/customs/terminals/:id. All editing happens via POST sub-routes on the
  // one shipping-lines page; these entity URLs have no GET, so a stray GET
  // (shared/bookmarked anchor, browser prefetch, back-button to a redirect
  // target, or a hand-typed URL) 404'd. Redirect to the page anchored on the
  // entity instead of erroring (José: "加港口 404").
  app.get("/admin/customs/ports/:portId", requireAuth, (req, res) => {
    return res.redirect(
      `/admin/customs/shipping-lines#customs-port-${req.params.portId}`
    );
  });
  app.get("/admin/customs/terminals/:terminalId", requireAuth, (req, res) => {
    return res.redirect(
      `/admin/customs/shipping-lines#customs-terminal-${req.params.terminalId}`
    );
  });

  app.post("/admin/customs/ports/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const port = buildCustomsPortDraft(moduleData, req.t);
    moduleData.ports = [...(moduleData.ports || []), port];
    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);

    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("customs.entityAdded", { name: port.name }),
      `/admin/customs/shipping-lines#customs-port-${port.id}`
    );
  });

  // O3b (20260617): delete a port and cascade-delete its terminals (the terminals
  // are nested under the port, so removing the port drops them too).
  app.post("/admin/customs/ports/:portId/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const beforeCount = (moduleData.ports || []).length;
    moduleData.ports = (moduleData.ports || []).filter(
      (entry) => entry.id !== req.params.portId
    );
    const removed = beforeCount !== moduleData.ports.length;
    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);

    return redirectWithFlash(
      req,
      res,
      removed ? "success" : "error",
      removed ? req.t("customs.portDeleted") : req.t("system.notFoundTitle"),
      "/admin/customs/shipping-lines#customs-terminal-rules"
    );
  });

  app.post(
    "/admin/customs/ports/:portId/terminals/add",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const portEntry = (moduleData.ports || []).find(
        (entry) => entry.id === req.params.portId
      );

      if (!portEntry) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const terminal = buildCustomsTerminalDraft(moduleData, portEntry, req.t);
      portEntry.terminals = [...(portEntry.terminals || []), terminal];
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("customs.entityAdded", { name: terminal.name }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/delete",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { portEntry, terminal } = findCustomsTerminal(
        moduleData,
        req.params.terminalId
      );

      if (!portEntry || !terminal) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const ruleSetCount = (terminal.storageRuleSets || []).length;
      portEntry.terminals = (portEntry.terminals || []).filter(
        (entry) => entry.id !== terminal.id
      );
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("customs.terminalDeleted", {
          name: terminal.name,
          count: ruleSetCount,
        }),
        "/admin/customs/shipping-lines#customs-terminal-rules"
      );
    }
  );

  // B2 (QA): add/delete terminal fixed charges (was edit-only — couldn't add a
  // 2nd fee or remove one). Mirrors the handover local-charges CRUD.
  app.post(
    "/admin/customs/terminals/:terminalId/fixed-charges/add",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { portEntry, terminal } = findCustomsTerminal(
        moduleData,
        req.params.terminalId
      );
      if (!portEntry || !terminal) {
        return res.status(404).render("not-found", baseView(req, { pageTitle: req.t("system.notFoundTitle"), languageReturnTo: req.originalUrl }));
      }
      const currency = moduleData.settings?.defaultQuoteCurrency || "MXN";
      terminal.fixedCharges = [
        ...(terminal.fixedCharges || []),
        {
          id: buildRuleId(`${terminal.id}-fixed`),
          concept: req.t("customs.defaultTerminalFixedCharge"),
          note: null,
          taxRate: 0,
          groupRates: buildZeroRatesByContainer(moduleData.containerTypes, currency),
          basis: "per_occurrence",
          required: false,
          amount: null,
          amountCurrency: "MXN",
        },
      ];
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);
      return redirectWithFlash(req, res, "success", req.t("customs.fixedChargeAdded"), `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`);
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/fixed-charges/:chargeId/delete",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { portEntry, terminal } = findCustomsTerminal(
        moduleData,
        req.params.terminalId
      );
      if (!portEntry || !terminal) {
        return res.status(404).render("not-found", baseView(req, { pageTitle: req.t("system.notFoundTitle"), languageReturnTo: req.originalUrl }));
      }
      const before = (terminal.fixedCharges || []).length;
      terminal.fixedCharges = (terminal.fixedCharges || []).filter(
        (c) => c.id !== req.params.chargeId
      );
      const removed = before !== terminal.fixedCharges.length;
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);
      return redirectWithFlash(req, res, removed ? "success" : "error", removed ? req.t("customs.fixedChargeDeleted") : req.t("system.notFoundTitle"), `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`);
    }
  );

  app.post("/admin/customs/yards/add", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const yard = buildCustomsYardDraft(moduleData, req.t);
    moduleData.yards = [...(moduleData.yards || []), yard];
    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);

    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("customs.entityAdded", { name: yard.name }),
      `/admin/customs/shipping-lines#customs-yard-${yard.id}`
    );
  });

  app.post("/admin/customs/yards/:yardId/delete", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const yard = (moduleData.yards || []).find(
      (entry) => entry.id === req.params.yardId
    );

    if (!yard) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    const portCount = (yard.portIds || []).length;
    const linkedLineIds = new Set(yard.shippingLineIds || []);
    for (const line of moduleData.shippingLines || []) {
      if ((line.yardIds || []).includes(yard.id)) {
        linkedLineIds.add(line.id);
      }
      line.yardIds = (line.yardIds || []).filter((yardId) => yardId !== yard.id);
    }
    moduleData.yards = (moduleData.yards || []).filter(
      (entry) => entry.id !== yard.id
    );
    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);

    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("customs.yardDeleted", {
        name: yard.name,
        ports: portCount,
        lines: linkedLineIds.size,
      }),
      "/admin/customs/shipping-lines#customs-yard-rules"
    );
  });

  app.post(
    "/admin/customs/terminals/:terminalId/storage-rule-sets/add",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);

      if (!terminal) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const ruleSet = buildCustomsStorageRuleSetDraft(
        moduleData,
        terminal,
        req.t
      );
      terminal.storageRuleSets = [...(terminal.storageRuleSets || []), ruleSet];
      syncTerminalStorageRulesByContainer(terminal, moduleData.shippingLines, moduleData.containerTypes);
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleSetAdded", { label: ruleSet.name }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage-rule-sets/:ruleSetId/add",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);
      const ruleSet = terminal?.storageRuleSets?.find(
        (entry) => entry.id === req.params.ruleSetId
      );

      if (!terminal || !ruleSet) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      ruleSet.rules = ruleSet.rules || [];
      appendProgressiveRule(
        ruleSet.rules,
        `${terminal.id}-${ruleSet.id}`,
        ruleSet.name
      );
      resequenceRules(ruleSet.rules);
      syncTerminalStorageRulesByContainer(terminal, moduleData.shippingLines, moduleData.containerTypes);
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleAdded", { label: ruleSet.name }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage-rule-sets/:ruleSetId/delete",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);
      const ruleSets = terminal?.storageRuleSets || [];
      const ruleSet = ruleSets.find((entry) => entry.id === req.params.ruleSetId);

      if (!terminal || !ruleSet) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      if (ruleSets.length <= 1) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("admin.cannotDeleteLastRuleSet"),
          `/admin/customs/shipping-lines#customs-storage-rule-${terminal.id}-${ruleSet.id}`
        );
      }

      const assignmentCount = unassignStorageRuleSetAssignments(
        terminal,
        ruleSet.id,
        moduleData.shippingLines,
        moduleData.containerTypes
      );
      terminal.storageRuleSets = ruleSets.filter(
        (entry) => entry.id !== ruleSet.id
      );
      syncTerminalStorageRulesByContainer(
        terminal,
        moduleData.shippingLines,
        moduleData.containerTypes
      );
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("customs.storageRuleSetDeleted", {
          name: ruleSet.name,
          count: assignmentCount,
        }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage-rule-sets/:ruleSetId/:ruleId/delete",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);
      const ruleSet = terminal?.storageRuleSets?.find(
        (entry) => entry.id === req.params.ruleSetId
      );

      if (!terminal || !ruleSet) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      ruleSet.rules = ruleSet.rules || [];
      if (!removeProgressiveRule(ruleSet.rules, req.params.ruleId)) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("admin.cannotDeleteLastRule"),
          `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
        );
      }

      resequenceRules(ruleSet.rules);
      syncTerminalStorageRulesByContainer(terminal, moduleData.shippingLines, moduleData.containerTypes);
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);
      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleDeleted", { label: ruleSet.name }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage/:groupKey/add",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);
      const containerType = (moduleData.containerTypes || []).find(
        (type) => type.key === req.params.groupKey
      );

      if (!terminal || !containerType) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const ruleSet = findAssignedStorageRuleSet(terminal, containerType.key);
      const rules =
        ruleSet?.rules || terminal.storageRulesByContainer?.[containerType.key] || [];
      appendProgressiveRule(
        rules,
        `${terminal.id}-${ruleSet?.id || containerType.key}`,
        ruleSet?.name || containerType.label
      );
      resequenceRules(rules);
      if (ruleSet) {
        ruleSet.rules = rules;
        syncTerminalStorageRulesByContainer(terminal, moduleData.shippingLines, moduleData.containerTypes);
      } else {
        terminal.storageRulesByContainer[containerType.key] = rules;
      }
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);

      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleAdded", { label: containerType.label }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage/:groupKey/:ruleId/delete",
    requireAuth,
    async (req, res) => {
      const shippingData = await loadShippingData({ refreshRates: false });
      const moduleData = structuredClone(getModuleData(shippingData, "customs"));
      const { terminal } = findCustomsTerminal(moduleData, req.params.terminalId);
      const containerType = (moduleData.containerTypes || []).find(
        (type) => type.key === req.params.groupKey
      );

      if (!terminal || !containerType) {
        return res.status(404).render(
          "not-found",
          baseView(req, {
            pageTitle: req.t("system.notFoundTitle"),
            languageReturnTo: req.originalUrl,
          })
        );
      }

      const ruleSet = findAssignedStorageRuleSet(terminal, containerType.key);
      const rules =
        ruleSet?.rules || terminal.storageRulesByContainer?.[containerType.key] || [];
      if (!removeProgressiveRule(rules, req.params.ruleId)) {
        return redirectWithFlash(
          req,
          res,
          "error",
          req.t("admin.cannotDeleteLastRule"),
          `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
        );
      }

      resequenceRules(rules);
      if (ruleSet) {
        ruleSet.rules = rules;
        syncTerminalStorageRulesByContainer(terminal, moduleData.shippingLines, moduleData.containerTypes);
      }
      shippingData.modules.customs = moduleData;
      await saveShippingData(shippingData);
      return redirectWithFlash(
        req,
        res,
        "success",
        req.t("admin.ruleDeleted", { label: containerType.label }),
        `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
      );
    }
  );

  async function removeCustomsStorageAssignment(
    req,
    res,
    { terminalId, lineId, containerTypeKey, returnRuleSetId = "" }
  ) {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const { terminal } = findCustomsTerminal(moduleData, terminalId);
    const shippingLine = (moduleData.shippingLines || []).find(
      (line) => line.id === lineId
    );
    const containerType = (moduleData.containerTypes || []).find(
      (type) => type.key === containerTypeKey
    );

    if (!terminal || !shippingLine || !containerType) {
      return res.status(404).render(
        "not-found",
        baseView(req, {
          pageTitle: req.t("system.notFoundTitle"),
          languageReturnTo: req.originalUrl,
        })
      );
    }

    if (terminal.storageAssignmentsByLineContainer?.[shippingLine.id]) {
      delete terminal.storageAssignmentsByLineContainer[shippingLine.id][
        containerType.key
      ];
    }

    const assignmentKey = getLineContainerAssignmentKey(
      shippingLine.id,
      containerType.key
    );
    terminal.storageUnassignedLineContainers = uniqueIds([
      ...(terminal.storageUnassignedLineContainers || []),
      assignmentKey,
    ]);
    syncTerminalStorageRulesByContainer(
      terminal,
      moduleData.shippingLines,
      moduleData.containerTypes
    );
    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);

    const safeReturnRuleSetId = String(returnRuleSetId || "");
    const returnRuleSetExists = (terminal.storageRuleSets || []).some(
      (ruleSet) => ruleSet.id === safeReturnRuleSetId
    );
    const returnHash = returnRuleSetExists
      ? `customs-storage-rule-${terminal.id}-${safeReturnRuleSetId}`
      : `customs-terminal-${terminal.id}`;

    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("customs.storageAssignmentRemoved", {
        line: shippingLine.name,
        type: containerType.label,
      }),
      `/admin/customs/shipping-lines#${returnHash}`
    );
  }

  app.post(
    "/admin/customs/terminals/:terminalId/storage-assignments/release",
    requireAuth,
    async (req, res) => {
      const returnRuleSetId = String(req.body.releaseRuleSetId || "");
      const assignmentKey = String(
        req.body[`releaseLineContainerKey_${returnRuleSetId}`] || ""
      );
      const [lineId, containerTypeKey] = assignmentKey.split("::");
      return removeCustomsStorageAssignment(req, res, {
        terminalId: req.params.terminalId,
        lineId,
        containerTypeKey,
        returnRuleSetId,
      });
    }
  );

  app.post(
    "/admin/customs/terminals/:terminalId/storage-assignments/:lineId/:containerTypeKey/delete",
    requireAuth,
    async (req, res) => {
      return removeCustomsStorageAssignment(req, res, {
        terminalId: req.params.terminalId,
        lineId: req.params.lineId,
        containerTypeKey: req.params.containerTypeKey,
        returnRuleSetId: req.query.returnRuleSetId,
      });
    }
  );

  app.post("/admin/customs/shipping-lines", requireAuth, async (req, res) => {
    const shippingData = await loadShippingData({ refreshRates: false });
    const moduleData = structuredClone(getModuleData(shippingData, "customs"));
    const yardSelectionsByLine = {};

    for (const line of moduleData.shippingLines || []) {
      line.notes = req.body[`customs_line_note_${line.id}`] || line.notes || null;
      line.yardIds = uniqueIds(ensureArray(req.body[`shippingLine_yardIds_${line.id}`]));
      yardSelectionsByLine[line.id] = new Set(line.yardIds);
    }

    for (const portEntry of moduleData.ports || []) {
      portEntry.name = req.body[`port_name_${portEntry.id}`] || portEntry.name;
      portEntry.note = req.body[`port_note_${portEntry.id}`] || null;

      for (const terminal of portEntry.terminals || []) {
        terminal.name = req.body[`terminal_name_${terminal.id}`] || terminal.name;
        terminal.note = req.body[`terminal_note_${terminal.id}`] || null;

        for (const charge of terminal.fixedCharges || []) {
          const chargePrefix = `terminal_charge_${terminal.id}_${charge.id}`;
          charge.concept =
            req.body[`terminal_charge_concept_${terminal.id}_${charge.id}`] || charge.concept;
          charge.note =
            req.body[`terminal_charge_note_${terminal.id}_${charge.id}`] || null;
          charge.taxRate = parseNumber(
            req.body[`terminal_charge_tax_${terminal.id}_${charge.id}`],
            charge.taxRate
          );
          // O3: per-charge config (basis / required / flat amount).
          charge.basis =
            req.body[`${chargePrefix}_basis`] === "per_day"
              ? "per_day"
              : "per_occurrence";
          charge.required = req.body[`${chargePrefix}_required`] === "on";
          const amountRaw = req.body[`${chargePrefix}_amount`];
          charge.amount =
            amountRaw !== undefined && String(amountRaw).trim() !== ""
              ? parseNumber(amountRaw, 0)
              : null;
          charge.amountCurrency =
            req.body[`${chargePrefix}_amountCurrency`] || charge.amountCurrency || "MXN";

          for (const type of moduleData.containerTypes || []) {
            applyRateCellUpdates(
              charge.groupRates?.[type.key],
              req.body,
              `terminal_charge_${terminal.id}_${charge.id}_${type.key}`
            );
          }
        }

        if (!terminal.storageRuleSets?.length) {
          terminal.storageRuleSets = [
            buildCustomsStorageRuleSetDraft(moduleData, terminal, req.t),
          ];
        }

        const validLineContainerKeys = new Set();
        for (const line of moduleData.shippingLines || []) {
          for (const type of moduleData.containerTypes || []) {
            validLineContainerKeys.add(
              getLineContainerAssignmentKey(line.id, type.key)
            );
          }
        }
        const storageAssignmentsByLineContainer = {};
        const storageUnassignedLineContainers = new Set(
          terminal.storageUnassignedLineContainers || []
        );
        for (const ruleSet of terminal.storageRuleSets || []) {
          ruleSet.rules = ruleSet.rules || [];
          ruleSet.name =
            req.body[`terminal_storage_set_${terminal.id}_${ruleSet.id}_name`] ||
            ruleSet.name;

          const selectedLineContainerKeys = uniqueIds(
            ensureArray(
              req.body[
                `terminal_storage_set_${terminal.id}_${ruleSet.id}_lineContainers`
              ]
            )
          );
          for (const assignmentKey of selectedLineContainerKeys) {
            if (!validLineContainerKeys.has(assignmentKey)) {
              continue;
            }

            const [lineId, typeKey] = assignmentKey.split("::");
            storageAssignmentsByLineContainer[lineId] =
              storageAssignmentsByLineContainer[lineId] || {};
            if (!storageAssignmentsByLineContainer[lineId][typeKey]) {
              storageAssignmentsByLineContainer[lineId][typeKey] = ruleSet.id;
              storageUnassignedLineContainers.delete(assignmentKey);
            }
          }

          const updateResult = applySequentialRuleUpdates({
            rules: ruleSet.rules,
            body: req.body,
            getPrefix: (rule) =>
              `terminal_storage_set_${terminal.id}_${ruleSet.id}_${rule.id}`,
            t: req.t,
          });
          if (!updateResult.ok) {
            return redirectWithFlash(
              req,
              res,
              "error",
              updateResult.message,
              `/admin/customs/shipping-lines#customs-terminal-${terminal.id}`
            );
          }
        }

        const fallbackStorageRuleSetId = terminal.storageRuleSets?.[0]?.id;
        for (const line of moduleData.shippingLines || []) {
          storageAssignmentsByLineContainer[line.id] =
            storageAssignmentsByLineContainer[line.id] || {};
          for (const type of moduleData.containerTypes || []) {
            const assignmentKey = getLineContainerAssignmentKey(line.id, type.key);
            if (
              !storageAssignmentsByLineContainer[line.id][type.key] &&
              !storageUnassignedLineContainers.has(assignmentKey)
            ) {
              storageAssignmentsByLineContainer[line.id][type.key] =
                fallbackStorageRuleSetId;
            }
          }
        }
        terminal.storageAssignmentsByLineContainer =
          storageAssignmentsByLineContainer;
        terminal.storageUnassignedLineContainers = [...storageUnassignedLineContainers]
          .filter((assignmentKey) => validLineContainerKeys.has(assignmentKey));
        syncTerminalStorageRulesByContainer(
          terminal,
          moduleData.shippingLines,
          moduleData.containerTypes
        );
      }
    }

    for (const yard of moduleData.yards || []) {
      yard.name = req.body[`yard_name_${yard.id}`] || yard.name;
      yard.note = req.body[`yard_note_${yard.id}`] || null;
      yard.portIds = uniqueIds(ensureArray(req.body[`yard_portIds_${yard.id}`]));
      const directShippingLineIds = uniqueIds(
        ensureArray(req.body[`yard_shippingLineIds_${yard.id}`])
      );
      const linkedFromLines = moduleData.shippingLines
        .filter((line) => yardSelectionsByLine[line.id]?.has(yard.id))
        .map((line) => line.id);
      yard.shippingLineIds = uniqueIds([...directShippingLineIds, ...linkedFromLines]);

      for (const charge of yard.dropoffCharges || []) {
        charge.concept = req.body[`yard_dropoff_concept_${yard.id}_${charge.id}`] || charge.concept;
        charge.note = req.body[`yard_dropoff_note_${yard.id}_${charge.id}`] || null;
        charge.taxRate = parseNumber(
          req.body[`yard_dropoff_tax_${yard.id}_${charge.id}`],
          charge.taxRate
        );
        for (const type of moduleData.containerTypes || []) {
          applyRateCellUpdates(
            charge.groupRates?.[type.key],
            req.body,
            `yard_dropoff_${yard.id}_${charge.id}_${type.key}`
          );
        }
      }

      for (const charge of yard.customsCharges || []) {
        charge.concept = req.body[`yard_customs_concept_${yard.id}_${charge.id}`] || charge.concept;
        charge.note = req.body[`yard_customs_note_${yard.id}_${charge.id}`] || null;
        charge.taxRate = parseNumber(
          req.body[`yard_customs_tax_${yard.id}_${charge.id}`],
          charge.taxRate
        );
        for (const type of moduleData.containerTypes || []) {
          applyRateCellUpdates(
            charge.groupRates?.[type.key],
            req.body,
            `yard_customs_${yard.id}_${charge.id}_${type.key}`
          );
        }
      }
    }

    for (const line of moduleData.shippingLines || []) {
      const linkedYards = moduleData.yards
        .filter((yard) => yard.shippingLineIds.includes(line.id))
        .map((yard) => yard.id);
      line.yardIds = uniqueIds([...(line.yardIds || []), ...linkedYards]);
    }

    shippingData.modules.customs = moduleData;
    await saveShippingData(shippingData);
    return redirectWithFlash(
      req,
      res,
      "success",
      req.t("admin.customsRulesSaved"),
      "/admin/customs/shipping-lines"
    );
  });
}

module.exports = { register };
