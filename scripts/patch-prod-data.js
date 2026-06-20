#!/usr/bin/env node
"use strict";

/**
 * Surgical prod data patch (round-r3 data deploy). Lands ONLY the r3 data
 * changes into the Supabase app_state "shipping-data", preserving every José
 * manual edit (diagnosis found: CMA doc fee 50, ZIM renames, COSCO rate edits,
 * KMTC ISD already 15, 2 José-created yards "新场站 4/5"). db:seed is NOT used
 * because it would clobber all of that.
 *
 * What it changes (and nothing else):
 *   E: handover line notes.code + notes.rfc <- local data/shipping-lines.json
 *      (fixes HAPAG NO ASIGNADO->HAPLLOMEX, ONE->ONE_MEX, adds 14 RFC).
 *   B: KMTC charge renames (Release Fee->Doc Fee at Destination,
 *      Container Handling->Container Release Fee) + ensure ISD Discharge = 15
 *      (idempotent; prod already 15).
 *   C: customs.yards -> drop the 3 fake demo yards (yard-mzo-norte/sur/lc-central),
 *      add the 26 CONTENTO patios, KEEP any other yard (José-created survive).
 *   --with-shells (optional): also create the 7 new-carrier empty shells.
 *
 * Writes via saveAppState (raw, NO full re-normalize) so prod's existing shape
 * and José edits are left untouched; getShippingData normalizes on read.
 *
 * SAFETY:
 *   - dry-run by default. Pass --apply to write. Pass --with-shells to add shells.
 *   - --apply re-backs-up prod to backups/ before writing.
 *   - NEVER prints secrets.
 *
 * Run (review):  node scripts/patch-prod-data.js
 * Run (write):   node scripts/patch-prod-data.js --apply
 */

const fs = require("node:fs");
const path = require("node:path");
require("../src/lib/env").loadLocalEnv();
const { getAppState, saveAppState, closeDatabase } = require("../src/lib/db");
const { buildContentoManzanilloYards } = require("../src/lib/contento-yards");
const { buildNewCarrierShells } = require("./seed-new-carriers");

const LOCAL = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "shipping-lines.json"), "utf8")
);
const FAKE_YARD_IDS = new Set(["yard-mzo-norte", "yard-mzo-sur", "yard-lc-central"]);
const KMTC_RENAMES = {
  "Release Fee": "Doc Fee at Destination",
  "Container Handling": "Container Release Fee",
};

function localLine(id) {
  return (LOCAL.modules.handover.shippingLines || []).find((l) => l.id === id);
}

function patch(prod, { withShells }) {
  const log = [];
  const handover = prod.modules.handover;
  const customs = prod.modules.customs;

  // E — notes.code + notes.rfc from local (source of truth)
  for (const line of handover.shippingLines || []) {
    const src = localLine(line.id);
    if (!src) continue;
    line.notes = line.notes && typeof line.notes === "object" ? line.notes : {};
    const beforeCode = line.notes.code ?? null;
    const beforeRfc = line.notes.rfc ?? null;
    if (src.notes?.code != null && line.notes.code !== src.notes.code) {
      line.notes.code = src.notes.code;
      log.push(`E ${line.id}: code ${JSON.stringify(beforeCode)} -> ${JSON.stringify(src.notes.code)}`);
    }
    if (src.notes?.rfc != null && line.notes.rfc !== src.notes.rfc) {
      line.notes.rfc = src.notes.rfc;
      log.push(`E ${line.id}: rfc ${JSON.stringify(beforeRfc)} -> ${JSON.stringify(src.notes.rfc)}`);
    }
  }

  // B — KMTC renames + ensure ISD 15
  const kmtc = (handover.shippingLines || []).find((l) => l.id === "kmtc");
  if (kmtc) {
    for (const charge of kmtc.localCharges || []) {
      if (KMTC_RENAMES[charge.concept]) {
        log.push(`B kmtc: rename "${charge.concept}" -> "${KMTC_RENAMES[charge.concept]}"`);
        charge.concept = KMTC_RENAMES[charge.concept];
      }
      if (charge.concept === "ISD Discharge") {
        for (const k of Object.keys(charge.groupRates || {})) {
          if (charge.groupRates[k].rate !== 15) {
            log.push(`B kmtc ISD ${k}: ${charge.groupRates[k].rate} -> 15`);
            charge.groupRates[k].rate = 15;
          }
        }
      }
    }
  }

  // C — replace fake yards with CONTENTO, keep everything else (José yards)
  const ctypes = handover.containerTypes || customs.containerTypes || [];
  const kept = (customs.yards || []).filter((y) => !FAKE_YARD_IDS.has(y.id));
  const keptNonContento = kept.filter((y) => !String(y.id).startsWith("yard-mzo-contento-"));
  const contento = buildContentoManzanilloYards(ctypes, "MXN");
  const removed = (customs.yards || []).filter((y) => FAKE_YARD_IDS.has(y.id)).map((y) => y.id);
  customs.yards = [...contento, ...keptNonContento];
  log.push(
    `C yards: removed fake [${removed.join(", ") || "none"}], added ${contento.length} CONTENTO, kept ${keptNonContento.length} other [${keptNonContento.map((y) => y.id).join(", ") || "none"}]`
  );

  // optional — 7 new-carrier shells
  if (withShells) {
    const before = (handover.shippingLines || []).length;
    const { handoverLines, customsMirrors, created, skipped } = buildNewCarrierShells(handover, customs);
    handover.shippingLines = handoverLines;
    customs.shippingLines = customsMirrors;
    log.push(`shells: created [${created.join(", ") || "none"}], skipped existing [${skipped.join(", ") || "none"}] (handover ${before} -> ${handover.shippingLines.length})`);
  }

  return log;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const withShells = process.argv.includes("--with-shells");
  try {
    const prod = await getAppState("shipping-data");
    if (!prod) {
      console.log("PROD app_state is EMPTY — nothing to patch (would seed from JSON on first load).");
      return;
    }

    // re-backup before any write
    if (apply) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const bpath = path.join(__dirname, "..", "backups", `prod-shipping-data-prepatch-${ts}.json`);
      fs.writeFileSync(bpath, JSON.stringify(prod, null, 2));
      console.log("[backup] pre-patch snapshot:", bpath);
    }

    const target = JSON.parse(JSON.stringify(prod));
    const log = patch(target, { withShells });

    console.log(`\n=== PATCH PLAN (${apply ? "APPLY" : "DRY-RUN"})${withShells ? " +shells" : ""} ===`);
    for (const line of log) console.log("  " + line);
    console.log(`  total changes: ${log.length}`);

    if (!apply) {
      console.log("\nDRY-RUN only. Re-run with --apply to write to prod (after Chandler approval).");
      return;
    }

    await saveAppState("shipping-data", target);
    console.log("\n[applied] prod app_state shipping-data updated.");
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

main();
