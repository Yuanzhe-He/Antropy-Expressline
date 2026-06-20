#!/usr/bin/env node
"use strict";

/**
 * One-off seed (Task E): backfill carrier metadata from the TARIFARIO ALL NAV
 * sheet into modules.handover.shippingLines[].notes:
 *   - fix HAPAG code "NO ASIGNADO" -> "HAPLLOMEX"
 *   - add `rfc` (Mexican tax id) for all 14 carriers (needed to invoice).
 *
 * Source: docs/client-info-source/20260619_jose_shipping_line_rate_update.md §5.1.
 * Surgical: only notes.code (HAPAG) and notes.rfc are touched; file re-serialized
 * with the same 2-space indent and no trailing newline. The store normalizer
 * (normalizeShippingLineNotes) supplies rfc=null for any line missing it.
 *
 * Run: node scripts/seed-shipping-line-metadata.js
 */

const fs = require("node:fs");
const path = require("node:path");

const DATA_PATH = path.join(__dirname, "..", "data", "shipping-lines.json");

// id -> { rfc, code? }  (code only set where it must change)
const META_BY_ID = {
  "cma-cgm": { rfc: "FR72562024422" },
  maersk: { rfc: "DK53139655" },
  zim: { rfc: "520015041" },
  msc: { rfc: "MSM980902IM6" },
  // [INCIDENTAL_FIX] ONE code was null in the system; ALL NAV gives ONE_MEX
  // (every other carrier code already matched ALL NAV). Excel-vs-system → Excel.
  one: { rfc: "201708450C", code: "ONE_MEX" },
  pil: { rfc: "PSM231215QG9" },
  "whan-hai": { rfc: "WHL2209281Q2" },
  hapag: { rfc: "HME980911KW7", code: "HAPLLOMEX" },
  evergreen: { rfc: "ESA1805216L9" },
  cosco: { rfc: "CSM150218UV0" },
  oocl: { rfc: "8502583000" },
  "yang-ming": { rfc: "RMA500422PT2" },
  kmtc: { rfc: "KMA250220IJ8" },
  rcl: { rfc: "ANT250220BU2" },
};

function main() {
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  const data = JSON.parse(raw);
  const lines = data.modules?.handover?.shippingLines || [];

  let codeFixes = 0;
  let rfcAdds = 0;
  const missing = [];

  for (const [id, meta] of Object.entries(META_BY_ID)) {
    const line = lines.find((l) => l.id === id);
    if (!line) {
      missing.push(id);
      continue;
    }
    line.notes = line.notes && typeof line.notes === "object" ? line.notes : {};
    if (meta.code && line.notes.code !== meta.code) {
      line.notes.code = meta.code;
      codeFixes += 1;
    }
    if (line.notes.rfc !== meta.rfc) {
      line.notes.rfc = meta.rfc;
      rfcAdds += 1;
    }
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");

  console.log(`[seed-shipping-line-metadata] rfc set on ${rfcAdds} line(s), code fixes: ${codeFixes}.`);
  if (missing.length) {
    console.log(`  WARNING — ids not found: ${missing.join(", ")}`);
  }
}

main();
