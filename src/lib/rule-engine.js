// Progressive rate-rule engine + the shared form/rate-cell primitives the admin
// rule editors (customs storage rules, shipping-line demurrage) are built on.
// Pure data transforms — no req/res, no I/O. Extracted from server.js as a pure
// move (bodies are byte-for-byte the originals).
//
// Layer: lib. Imports only ./calculate (parseNumber) and ./store
// (formatDemurrageRuleLabel). routes/* and the sibling lib helpers
// (customs-rules, handover-forms) build on these — never the reverse.
//
// Public API: ensureArray, uniqueIds, parseWholeNumber, buildRuleId,
// cloneRateConfig, buildZeroRatesByContainer, getLineContainerAssignmentKey,
// applyRateCellUpdates, upsertRateCell, appendProgressiveRule, resequenceRules,
// removeProgressiveRule, unassignStorageRuleSetAssignments,
// applySequentialRuleUpdates.

const { parseNumber } = require("./calculate");
const { formatDemurrageRuleLabel } = require("./store");

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function uniqueIds(values) {
  return [...new Set(values.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function parseWholeNumber(value, fallback = 0) {
  return Math.max(0, Math.trunc(parseNumber(value, fallback)));
}

function buildRuleId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneRateConfig(rateConfig = {}) {
  return {
    label: rateConfig.label || "",
    qtyHint: parseNumber(rateConfig.qtyHint, 1) || 1,
    currency: rateConfig.currency || "MXN",
    rate: parseNumber(rateConfig.rate, 0),
  };
}

function buildZeroRatesByContainer(containerTypes = [], currency = "MXN") {
  return Object.fromEntries(
    (containerTypes || []).map((type) => [
      type.key,
      {
        label: type.label,
        qtyHint: 1,
        currency,
        rate: 0,
      },
    ])
  );
}

function getLineContainerAssignmentKey(lineId, containerTypeKey) {
  return `${lineId}::${containerTypeKey}`;
}

function applyRateCellUpdates(rateConfig, body, prefix) {
  if (!rateConfig) {
    return;
  }
  rateConfig.rate = parseNumber(body[`${prefix}_rate`], rateConfig.rate);
  rateConfig.currency = body[`${prefix}_currency`] || rateConfig.currency;
}

// H2/H3 (20260617): the admin rate cells now always render an editable input,
// even when no rate object exists yet. This upsert creates the rate object when
// a value is submitted into a previously-empty cell, updates it when present,
// and clears it (null) when the cell is blanked. `container[key]` is the rate
// slot (e.g. charge.blRate, charge.groupRates[groupKey], guarantee.ratesByGroup[groupKey]).
function upsertRateCell(container, key, body, prefix) {
  if (!container) {
    return;
  }
  const rawRate = body[`${prefix}_rate`];
  const hasValue = rawRate !== undefined && String(rawRate).trim() !== "";
  if (!hasValue) {
    if (container[key]) {
      container[key] = null;
    }
    return;
  }
  const existing =
    container[key] && typeof container[key] === "object" ? container[key] : {};
  container[key] = {
    ...existing,
    rate: parseNumber(rawRate, 0),
    currency: body[`${prefix}_currency`] || existing.currency || "MXN",
  };
}

function appendProgressiveRule(rules, prefix, label) {
  if (!rules.length) {
    rules.push({
      id: buildRuleId(prefix),
      label: "0-0",
      note: null,
      startDay: 1,
      endDay: null,
      freeRule: true,
      taxRate: 0,
      rateConfig: {
        label,
        qtyHint: 1,
        currency: "MXN",
        rate: 0,
      },
    });
    return;
  }

  const lastRule = rules[rules.length - 1];
  const anchorDay = lastRule.endDay ?? lastRule.startDay ?? 1;
  if (lastRule.endDay === null) {
    lastRule.endDay = anchorDay;
  }

  rules.push({
    id: buildRuleId(prefix),
    label: `>${anchorDay}`,
    note: null,
    startDay: anchorDay + 1,
    endDay: null,
    freeRule: false,
    taxRate: parseNumber(lastRule.taxRate, 0),
    rateConfig: cloneRateConfig({
      ...lastRule.rateConfig,
      label,
    }),
  });
}

function resequenceRules(rules) {
  let nextStart = 1;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    rule.startDay = nextStart;
    if (rule.endDay !== null && rule.endDay < nextStart) {
      rule.endDay = nextStart;
    }
    rule.freeRule = Number(rule.rateConfig?.rate || 0) === 0;
    rule.label = formatDemurrageRuleLabel(
      rule.startDay,
      rule.endDay,
      rule.freeRule
    );
    if (rule.endDay !== null) {
      nextStart = rule.endDay + 1;
    }
  }
}

function removeProgressiveRule(rules, ruleId) {
  if (!rules.length || rules.length === 1) {
    return false;
  }

  const ruleIndex = rules.findIndex((rule) => rule.id === ruleId);
  if (ruleIndex < 0) {
    return false;
  }

  rules.splice(ruleIndex, 1);
  return true;
}

function unassignStorageRuleSetAssignments(
  terminal,
  ruleSetId,
  shippingLines = [],
  containerTypes = []
) {
  const unassignedKeys = new Set(terminal.storageUnassignedLineContainers || []);
  let count = 0;

  for (const line of shippingLines || []) {
    const lineAssignments =
      terminal.storageAssignmentsByLineContainer?.[line.id] || {};
    for (const type of containerTypes || []) {
      if (lineAssignments[type.key] !== ruleSetId) {
        continue;
      }
      delete lineAssignments[type.key];
      unassignedKeys.add(getLineContainerAssignmentKey(line.id, type.key));
      count += 1;
    }

    if (
      terminal.storageAssignmentsByLineContainer?.[line.id] &&
      !Object.keys(lineAssignments).length
    ) {
      delete terminal.storageAssignmentsByLineContainer[line.id];
    }
  }

  for (const [typeKey, assignedRuleSetId] of Object.entries(
    terminal.storageAssignmentsByContainerType || {}
  )) {
    if (assignedRuleSetId === ruleSetId) {
      delete terminal.storageAssignmentsByContainerType[typeKey];
    }
  }

  terminal.storageUnassignedLineContainers = uniqueIds([...unassignedKeys]);
  return count;
}

function applySequentialRuleUpdates({
  rules,
  body,
  getPrefix,
  t,
}) {
  let nextStart = 1;

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const prefix = getPrefix(rule);
    const rawEnd = body[`${prefix}_end`];
    const endDay = rawEnd === "" ? null : parseWholeNumber(rawEnd, rule.endDay);

    if (endDay !== null && endDay < nextStart) {
      return {
        ok: false,
        message: t("admin.invalidRuleRange", {
          start: nextStart,
          end: endDay,
        }),
      };
    }

    if (endDay === null && index < rules.length - 1) {
      return {
        ok: false,
        message: t("admin.openEndedRuleMustBeLast"),
      };
    }

    rule.startDay = nextStart;
    rule.endDay = endDay;
    rule.taxRate = parseNumber(body[`${prefix}_tax`], rule.taxRate);
    applyRateCellUpdates(rule.rateConfig, body, prefix);
    rule.freeRule = Number(rule.rateConfig?.rate || 0) === 0;
    rule.label = formatDemurrageRuleLabel(
      rule.startDay,
      rule.endDay,
      rule.freeRule
    );

    if (rule.endDay !== null) {
      nextStart = rule.endDay + 1;
    }
  }

  return { ok: true };
}

module.exports = {
  ensureArray,
  uniqueIds,
  parseWholeNumber,
  buildRuleId,
  cloneRateConfig,
  buildZeroRatesByContainer,
  getLineContainerAssignmentKey,
  applyRateCellUpdates,
  upsertRateCell,
  appendProgressiveRule,
  resequenceRules,
  removeProgressiveRule,
  unassignStorageRuleSetAssignments,
  applySequentialRuleUpdates,
};
