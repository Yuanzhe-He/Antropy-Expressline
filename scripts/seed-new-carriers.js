#!/usr/bin/env node
"use strict";

/**
 * The 7 new suppliers José flagged (ALL NAV placeholders). Built as empty shells
 * (name only; code/rfc/rates left for José) so they exist in the carrier list and
 * José can fill them via the now-live admin UI. Mirrors the D create flow:
 * minimal handover line (the store normalizer completes guarantee/demurrage/etc.)
 * + a lightweight customs.shippingLines mirror.
 *
 * Idempotent: a carrier whose id already exists is skipped (not duplicated).
 *
 * Used by scripts/patch-prod-data.js (--with-shells) and as a reusable builder.
 */

const NEW_CARRIERS = [
  { name: "ESL (Emirates Shipping Line)", code: null },
  { name: "SINOKOR", code: null },
  { name: "SL", code: null },
  { name: "SEA LEAD", code: null },
  { name: "TS LINES", code: null },
  { name: "HMM", code: null },
  { name: "SINOTRANS", code: null },
];

const DEFAULT_GROUPS = [
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

function uniqueId(base, taken) {
  let id = base || "naviera";
  let n = 2;
  while (taken.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

function buildShell(name, code, taken) {
  const id = uniqueId(slugifyLineId(name), taken);
  return {
    id,
    name: String(name).trim(),
    active: true,
    containerGroups: DEFAULT_GROUPS.map((g) => ({ ...g })),
    invoiceToConsigneeOnly: false,
    invoiceNote: null,
    terminalMix: [],
    localCharges: [],
    notes: { sourceSheet: "ALL NAV (nuevo proveedor)", code: code || null, rfc: null },
  };
}

function buildMirror(line) {
  return {
    id: line.id,
    name: line.name,
    active: true,
    notes: line.notes ? { ...line.notes } : null,
    yardIds: [],
  };
}

/**
 * Returns the new handover.shippingLines + customs.shippingLines arrays with the
 * 7 shells appended (skipping any whose slug already exists by id or name).
 */
function buildNewCarrierShells(handover, customs) {
  const handoverLines = [...(handover.shippingLines || [])];
  const customsMirrors = [...(customs.shippingLines || [])];
  const takenIds = new Set(handoverLines.map((l) => l.id));
  const takenNames = new Set(handoverLines.map((l) => (l.name || "").toUpperCase()));
  const created = [];
  const skipped = [];

  for (const carrier of NEW_CARRIERS) {
    if (takenNames.has(carrier.name.toUpperCase())) {
      skipped.push(carrier.name);
      continue;
    }
    const line = buildShell(carrier.name, carrier.code, takenIds);
    takenIds.add(line.id);
    takenNames.add(line.name.toUpperCase());
    handoverLines.push(line);
    customsMirrors.push(buildMirror(line));
    created.push(line.id);
  }

  return { handoverLines, customsMirrors, created, skipped };
}

module.exports = { NEW_CARRIERS, buildNewCarrierShells };
