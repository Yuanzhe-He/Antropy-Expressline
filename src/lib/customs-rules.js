// Customs draft builders + storage rule-set assignment sync. Pure data
// transforms over the customs module (ports/terminals/yards/storage rules) —
// no req/res, no I/O. Extracted from server.js as a pure move (bodies are
// byte-for-byte the originals).
//
// Layer: lib. Imports the shared primitives from ./rule-engine; never imports
// routes or the other route-side helpers.
//
// Public API: findCustomsTerminal, buildDefaultCustomsStorageRules,
// buildCustomsStorageRuleSetDraft, findAssignedStorageRuleSet,
// getAssignedStorageRuleSetId, syncTerminalStorageRulesByContainer,
// buildCustomsTerminalDraft, buildCustomsPortDraft,
// countCustomsContainerReferences, buildCustomsYardDraft.

const {
  buildRuleId,
  buildZeroRatesByContainer,
  getLineContainerAssignmentKey,
} = require("./rule-engine");

function findCustomsTerminal(moduleData, terminalId) {
  for (const portEntry of moduleData.ports || []) {
    const terminal = (portEntry.terminals || []).find(
      (entry) => entry.id === terminalId
    );
    if (terminal) {
      return { portEntry, terminal };
    }
  }
  return { portEntry: null, terminal: null };
}

function buildDefaultCustomsStorageRules(
  containerTypes = [],
  prefix,
  currency = "MXN"
) {
  return Object.fromEntries(
    (containerTypes || []).map((type) => [
      type.key,
      [
        {
          id: buildRuleId(`${prefix}-${type.key}-free`),
          startDay: 1,
          endDay: 7,
          freeRule: true,
          taxRate: 0,
          rateConfig: {
            label: type.label,
            qtyHint: 1,
            currency,
            rate: 0,
          },
        },
        {
          id: buildRuleId(`${prefix}-${type.key}-tier`),
          startDay: 8,
          endDay: null,
          freeRule: false,
          taxRate: 0,
          rateConfig: {
            label: type.label,
            qtyHint: 1,
            currency,
            rate: 0,
          },
        },
      ],
    ])
  );
}

function buildCustomsStorageRuleSetDraft(moduleData, terminal, t) {
  const index = (terminal.storageRuleSets || []).length + 1;
  const id = buildRuleId(`${terminal.id}-storage-set`);
  const name = t("customs.newStorageRuleSetName", { count: index });
  const currency = moduleData.settings?.defaultQuoteCurrency || "MXN";
  const sampleType = moduleData.containerTypes?.[0] || {
    key: "storage",
    label: name,
  };
  const rules =
    buildDefaultCustomsStorageRules([sampleType], `${id}-rules`, currency)[
      sampleType.key
    ] || [];

  return {
    id,
    name,
    sourceContainerKey: null,
    rules: rules.map((rule) => ({
      ...rule,
      rateConfig: {
        ...rule.rateConfig,
        label: name,
      },
    })),
  };
}

function findAssignedStorageRuleSet(terminal, containerTypeKey) {
  const ruleSets = Array.isArray(terminal.storageRuleSets)
    ? terminal.storageRuleSets
    : [];
  if (!ruleSets.length) {
    return null;
  }

  const assignedRuleSetId =
    terminal.storageAssignmentsByContainerType?.[containerTypeKey];
  const assignedRuleSetIds = Array.isArray(assignedRuleSetId)
    ? assignedRuleSetId
    : [assignedRuleSetId].filter(Boolean);
  return (
    ruleSets.find((ruleSet) => ruleSet.id === assignedRuleSetIds[0]) ||
    ruleSets.find((ruleSet) => ruleSet.sourceContainerKey === containerTypeKey) ||
    ruleSets[0]
  );
}

function getAssignedStorageRuleSetId(terminal, shippingLineId, containerTypeKey) {
  return (
    terminal.storageAssignmentsByLineContainer?.[shippingLineId]?.[
      containerTypeKey
    ] || terminal.storageAssignmentsByContainerType?.[containerTypeKey]
  );
}

function syncTerminalStorageRulesByContainer(
  terminal,
  shippingLines = [],
  containerTypes = []
) {
  const ruleSets = Array.isArray(terminal.storageRuleSets)
    ? terminal.storageRuleSets
    : [];
  if (!ruleSets.length) {
    return;
  }

  const lineAssignments = terminal.storageAssignmentsByLineContainer || {};
  const containerAssignments = terminal.storageAssignmentsByContainerType || {};
  const validRuleSetIds = new Set(ruleSets.map((ruleSet) => ruleSet.id));
  const unassignedKeys = new Set(terminal.storageUnassignedLineContainers || []);
  terminal.storageAssignmentsByLineContainer = {};
  terminal.storageAssignmentsByContainerType = {};
  terminal.storageRulesByContainer = terminal.storageRulesByContainer || {};

  for (const line of shippingLines || []) {
    terminal.storageAssignmentsByLineContainer[line.id] = {};

    for (const type of containerTypes || []) {
      const assignmentKey = getLineContainerAssignmentKey(line.id, type.key);
      if (unassignedKeys.has(assignmentKey)) {
        continue;
      }

      const assignedValue = lineAssignments[line.id]?.[type.key];
      const assignedRuleSetId = Array.isArray(assignedValue)
        ? assignedValue[0]
        : assignedValue;
      let ruleSetId = validRuleSetIds.has(assignedRuleSetId)
        ? assignedRuleSetId
        : null;

      if (!ruleSetId) {
        const containerValue = containerAssignments[type.key];
        const containerRuleSetId = Array.isArray(containerValue)
          ? containerValue[0]
          : containerValue;
        ruleSetId = validRuleSetIds.has(containerRuleSetId)
          ? containerRuleSetId
          : null;
      }

      if (!ruleSetId) {
        ruleSetId =
          ruleSets.find((ruleSet) => ruleSet.sourceContainerKey === type.key)
            ?.id || ruleSets[0].id;
      }

      terminal.storageAssignmentsByLineContainer[line.id][type.key] = ruleSetId;
    }

    if (!Object.keys(terminal.storageAssignmentsByLineContainer[line.id]).length) {
      delete terminal.storageAssignmentsByLineContainer[line.id];
    }
  }

  const firstLineId = shippingLines?.[0]?.id;
  for (const type of containerTypes || []) {
    const ruleSetId =
      firstLineId &&
      getAssignedStorageRuleSetId(terminal, firstLineId, type.key);
    const ruleSet =
      ruleSets.find((entry) => entry.id === ruleSetId) || ruleSets[0];
    terminal.storageAssignmentsByContainerType[type.key] = ruleSet.id;
    terminal.storageRulesByContainer[type.key] = structuredClone(
      ruleSet.rules || []
    );
  }
}

function buildCustomsTerminalDraft(moduleData, portEntry, t) {
  const index = (portEntry.terminals || []).length + 1;
  const id = buildRuleId(`${portEntry.id}-terminal`);
  const currency = moduleData.settings?.defaultQuoteCurrency || "MXN";
  const terminal = {
    id,
    name: t("customs.newTerminalName", { count: index }),
    note: null,
    fixedCharges: [
      {
        id: `${id}-fixed`,
        concept: t("customs.defaultTerminalFixedCharge"),
        note: null,
        taxRate: 0,
        groupRates: buildZeroRatesByContainer(moduleData.containerTypes, currency),
        // O3: per-charge config defaults (kept in lockstep with normalizeCustomsCharge).
        basis: "per_occurrence",
        required: false,
        amount: null,
        amountCurrency: "MXN",
      },
    ],
    storageRulesByContainer: buildDefaultCustomsStorageRules(
      moduleData.containerTypes,
      `${id}-storage`,
      currency
    ),
  };
  const storageRuleSet = buildCustomsStorageRuleSetDraft(moduleData, terminal, t);
  terminal.storageRuleSets = [storageRuleSet];
  terminal.storageAssignmentsByContainerType = Object.fromEntries(
    (moduleData.containerTypes || []).map((type) => [type.key, storageRuleSet.id])
  );
  terminal.storageAssignmentsByLineContainer = Object.fromEntries(
    (moduleData.shippingLines || []).map((line) => [
      line.id,
      Object.fromEntries(
        (moduleData.containerTypes || []).map((type) => [
          type.key,
          storageRuleSet.id,
        ])
      ),
    ])
  );
  terminal.storageUnassignedLineContainers = [];
  syncTerminalStorageRulesByContainer(
    terminal,
    moduleData.shippingLines,
    moduleData.containerTypes
  );

  return terminal;
}

function buildCustomsPortDraft(moduleData, t) {
  const index = (moduleData.ports || []).length + 1;
  const id = buildRuleId("customs-port");
  const port = {
    id,
    name: t("customs.newPortName", { count: index }),
    note: null,
    terminals: [],
  };
  port.terminals = [buildCustomsTerminalDraft(moduleData, port, t)];
  return port;
}

// Count non-zero customs rates keyed by a container type. Used to warn before
// deleting a container type from the master (handover rates are keyed by rate
// group, not by container type, so only customs holds per-container references).
function countCustomsContainerReferences(customsData, key) {
  let count = 0;
  const scanCharges = (charges) => {
    for (const charge of charges || []) {
      const rate = charge.groupRates?.[key];
      if (rate && Number(rate.rate) > 0) {
        count += 1;
      }
    }
  };
  for (const port of customsData?.ports || []) {
    for (const terminal of port.terminals || []) {
      scanCharges(terminal.fixedCharges);
    }
  }
  for (const yard of customsData?.yards || []) {
    scanCharges(yard.dropoffCharges);
    scanCharges(yard.customsCharges);
  }
  return count;
}

function buildCustomsYardDraft(moduleData, t) {
  const index = (moduleData.yards || []).length + 1;
  const id = buildRuleId("customs-yard");
  const currency = moduleData.settings?.defaultQuoteCurrency || "MXN";

  return {
    id,
    name: t("customs.newYardName", { count: index }),
    note: null,
    portIds: moduleData.ports?.[0]?.id ? [moduleData.ports[0].id] : [],
    shippingLineIds: [],
    dropoffCharges: [
      {
        id: `${id}-dropoff`,
        concept: t("customs.defaultDropoffCharge"),
        note: null,
        taxRate: 0,
        groupRates: buildZeroRatesByContainer(moduleData.containerTypes, currency),
      },
    ],
    customsCharges: [
      {
        id: `${id}-customs`,
        concept: t("customs.defaultCustomsYardCharge"),
        note: null,
        taxRate: 0,
        groupRates: buildZeroRatesByContainer(moduleData.containerTypes, currency),
      },
    ],
  };
}

module.exports = {
  findCustomsTerminal,
  buildDefaultCustomsStorageRules,
  buildCustomsStorageRuleSetDraft,
  findAssignedStorageRuleSet,
  getAssignedStorageRuleSetId,
  syncTerminalStorageRulesByContainer,
  buildCustomsTerminalDraft,
  buildCustomsPortDraft,
  countCustomsContainerReferences,
  buildCustomsYardDraft,
};
