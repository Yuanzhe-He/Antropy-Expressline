#!/usr/bin/env node
"use strict";

/**
 * One-off seed: replace `modules.customs.yards` in data/shipping-lines.json with
 * the real CONTENTO Manzanillo empty-return patios (método B — prices in,
 * naviera↔patio mapping left empty for José). The previous three yards
 * (Patio Aduanal Norte / Fiscal Sur / Central Lazaro) were placeholder demo
 * data (round16: confirmed fake seed) and are dropped.
 *
 * Surgical by design: only `modules.customs.yards` is reassigned; the file is
 * re-serialized with the same 2-space indent and no trailing newline, so the
 * git diff is limited to the yards block. groupRates are keyed by the handover
 * container types (the taxonomy the store normalizer re-keys customs onto),
 * so they survive a load through normalizeShippingData without zeroing.
 *
 * Run: node scripts/seed-contento-yards.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { buildContentoManzanilloYards } = require("../src/lib/contento-yards");

const DATA_PATH = path.join(__dirname, "..", "data", "shipping-lines.json");

function main() {
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  const data = JSON.parse(raw);

  const customs = data.modules && data.modules.customs;
  if (!customs) {
    throw new Error("modules.customs not found in shipping-lines.json");
  }

  // The store normalizer keys customs per-container rates onto the handover
  // container taxonomy; mirror that here so the seeded rates do not get zeroed.
  const containerTypes =
    (data.modules.handover && data.modules.handover.containerTypes) ||
    customs.containerTypes ||
    [];

  const before = (customs.yards || []).map((y) => y.id);
  customs.yards = buildContentoManzanilloYards(containerTypes, "MXN");
  const after = customs.yards.map((y) => y.id);

  // Preserve original formatting: 2-space indent, no trailing newline.
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");

  console.log(`[seed-contento-yards] replaced ${before.length} yard(s) with ${after.length} CONTENTO patio(s).`);
  console.log(`  removed: ${before.join(", ") || "(none)"}`);
  console.log(`  added:   ${after.length} yards, e.g. ${after.slice(0, 3).join(", ")} …`);
}

main();
