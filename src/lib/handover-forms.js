// Handover / shipping-line form + draft builders: new-carrier drafts, the
// customs-side mirror, local-charge drafts, terminal-mix drafts + percent
// formatting, and the handover calculator form-data parsing. Pure data
// transforms over a request body / module data — no req/res, no I/O. Extracted
// from server.js as a pure move (bodies are byte-for-byte the originals).
//
// Layer: lib. Imports the shared primitives from ./rule-engine, parseNumber
// from ./calculate, and normalizeBusinessNature from ./options. Never imports
// routes.
//
// Public API: slugifyLineId, buildShippingLineDraft, buildSimpleShippingLineMirror,
// inferLocalChargeCurrency, buildLocalChargeDraft, parsePercentRatio,
// formatPercentValue, formatTerminalMixSummary, buildTerminalMixDraft,
// buildTaxOverrides, buildDefaultContainerRows, buildHandoverFormData,
// buildTaxRatePresets.

const { parseNumber } = require("./calculate");
const { normalizeBusinessNature } = require("./options");
const {
  ensureArray,
  parseWholeNumber,
  buildRuleId,
  buildZeroRatesByContainer,
} = require("./rule-engine");

// D (round-r3): new-carrier onboarding. A new line is created minimal; the store
// normalizer fills guarantee/demurrage/quoteDefaults/notes. We seed the two
// standard container groups so the edit UI (charges/garantía/demoras) has
// anchors — container-group editing is out of scope for this round.
const DEFAULT_NEW_LINE_CONTAINER_GROUPS = [
  { key: "gp-hc-sd", label: "GP HC SD" },
  { key: "ot-fr-rf", label: "OT FR RF" },
];

function slugifyLineId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildShippingLineDraft(moduleData, { name, code, rfc } = {}) {
  const trimmedName = String(name || "").trim();
  const existingIds = new Set((moduleData.shippingLines || []).map((line) => line.id));
  const base = slugifyLineId(trimmedName) || "naviera";
  let id = base;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return {
    id,
    name: trimmedName,
    active: true,
    containerGroups: DEFAULT_NEW_LINE_CONTAINER_GROUPS.map((group) => ({ ...group })),
    invoiceToConsigneeOnly: false,
    invoiceNote: null,
    terminalMix: [],
    localCharges: [],
    notes: {
      sourceSheet: null,
      code: String(code || "").trim() || null,
      rfc: String(rfc || "").trim() || null,
    },
  };
}

// Lightweight customs-side mirror so a new carrier is selectable in the
// yard↔line mapping (customs.shippingLines is a separate list, not auto-synced).
function buildSimpleShippingLineMirror(line) {
  return {
    id: line.id,
    name: line.name,
    active: true,
    notes: line.notes ? { ...line.notes } : null,
    yardIds: [],
  };
}

function inferLocalChargeCurrency(shippingLine, moduleData) {
  for (const charge of shippingLine.localCharges || []) {
    if (charge.blRate?.currency) {
      return charge.blRate.currency;
    }

    const groupRate = Object.values(charge.groupRates || {}).find(
      (rate) => rate?.currency
    );
    if (groupRate?.currency) {
      return groupRate.currency;
    }
  }

  return (
    shippingLine.quoteDefaults?.quoteCurrency ||
    moduleData.settings?.defaultQuoteCurrency ||
    "USD"
  );
}

function buildLocalChargeDraft(shippingLine, moduleData, t) {
  const localCharges = shippingLine.localCharges || [];
  const currency = inferLocalChargeCurrency(shippingLine, moduleData);
  const id = buildRuleId(`${shippingLine.id}-local-charge`);

  return {
    id,
    concept: t("admin.newLocalChargeName", { count: localCharges.length + 1 }),
    note: null,
    taxRate: 0,
    groupRates: buildZeroRatesByContainer(
      shippingLine.containerGroups || moduleData.containerTypes || [],
      currency
    ),
    blRate: {
      qtyHint: 1,
      currency,
      rate: 0,
    },
  };
}

function parsePercentRatio(value, fallback = 0) {
  return Math.min(1, Math.max(0, parseNumber(value, fallback * 100) / 100));
}

function formatPercentValue(ratio) {
  const percent = Math.round(parseNumber(ratio, 0) * 10000) / 100;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(2);
}

function formatTerminalMixSummary(entries = [], t) {
  if (!entries.length) {
    return t("calculator.noTerminalMix");
  }

  const byPort = new Map();
  for (const entry of entries) {
    const port = entry.port || "MANZANILLO";
    if (!byPort.has(port)) {
      byPort.set(port, []);
    }
    byPort.get(port).push(`${entry.terminal} ${formatPercentValue(entry.ratio)}%`);
  }

  return [...byPort.entries()]
    .map(([port, terminals]) => `${port}: ${terminals.join(" / ")}`)
    .join(" | ");
}

function buildTerminalMixDraft(line, t) {
  const existing = line.terminalMix || [];
  return {
    id: buildRuleId(`terminal-mix-${line.id}`),
    port: existing[0]?.port || "MANZANILLO",
    terminal: t("admin.newTerminalMixTerminal"),
    ratio: 0,
  };
}

function buildTaxOverrides(body) {
  const keys = ensureArray(body.taxOverrideKey);
  const values = ensureArray(body.taxOverrideRate);
  const taxOverrides = {};

  keys.forEach((key, index) => {
    if (!key) {
      return;
    }
    taxOverrides[key] = values[index] || "default";
  });

  return taxOverrides;
}

function buildDefaultContainerRows(typeList) {
  return [
    {
      containerGroupKey: typeList?.[0]?.key || "",
      quantity: 1,
    },
  ];
}

function buildHandoverFormData(selectedLine, body, settings, containerTypes = []) {
  const groupKeys = ensureArray(body.containerGroupKey);
  const quantities = ensureArray(body.containerCount);
  const containerRows = groupKeys.map((groupKey, index) => ({
    containerGroupKey: groupKey,
    quantity: parseWholeNumber(quantities[index], 0),
  }));

  return {
    shippingLineId: body.shippingLineId || selectedLine?.id || "",
    blCount: parseWholeNumber(body.blCount, 1),
    demurrageDays: parseWholeNumber(body.demurrageDays, 0),
    priceMode: body.priceMode || settings.defaultPriceMode,
    quoteCurrency: body.quoteCurrency || settings.defaultQuoteCurrency,
    businessNature: normalizeBusinessNature(
      body.businessNature,
      "handover_only"
    ),
    taxOverrides: buildTaxOverrides(body),
    containerRows: containerRows.length
      ? containerRows
      : buildDefaultContainerRows(containerTypes),
  };
}

function buildTaxRatePresets(body) {
  const ids = ensureArray(body.taxPresetId);
  const labels = ensureArray(body.taxPresetLabel);
  const rates = ensureArray(body.taxPresetRate);

  return ids
    .map((id, index) => ({
      id: id || `tax-rate-${index + 1}`,
      label: labels[index] || "",
      rate: parseNumber(rates[index], NaN),
    }))
    .filter((preset) => preset.label && Number.isFinite(preset.rate));
}

module.exports = {
  slugifyLineId,
  buildShippingLineDraft,
  buildSimpleShippingLineMirror,
  inferLocalChargeCurrency,
  buildLocalChargeDraft,
  parsePercentRatio,
  formatPercentValue,
  formatTerminalMixSummary,
  buildTerminalMixDraft,
  buildTaxOverrides,
  buildDefaultContainerRows,
  buildHandoverFormData,
  buildTaxRatePresets,
};
