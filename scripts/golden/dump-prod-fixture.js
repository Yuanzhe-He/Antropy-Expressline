#!/usr/bin/env node
"use strict";

// Read-only prod snapshot dumper for the golden fixture — standardizes the
// previously out-of-band step (batch-1's fixture had no committed generator).
//
// Behavior:
//   - READ-ONLY: single store.getShippingData(); zero writes.
//   - exchangeRates are NEVER dumped from prod. They are inherited verbatim
//     from the existing fixture at FIXTURE_PATH (the golden-pin: provider
//     "golden-pin", USD/MXN 17.5) so a regen never injects live-FX noise into
//     the golden baseline. Missing/foreign fixture -> hard error.
//   - modules are projected to the exact sanitized shape the fixture has
//     always used (pricing structures only; no credentials, no notes/quote
//     defaults/terminal mixes): settings {defaultQuoteCurrency,
//     defaultPriceMode, containerTypeMasterVersion}; containerTypes {key,
//     label, rateGroup}; shippingLines {id, name, containerGroups{key,label},
//     localCharges{id concept note taxRate blRate groupRates}, demurrage,
//     guarantee}.
//
// Usage: update GENERATED_FROM + FIXTURE_PATH for the new batch, git mv the
// old fixture to FIXTURE_PATH first (keeps a single fixture file, batch-1
// precedent), then run:  node scripts/golden/dump-prod-fixture.js

process.env.STORAGE_DRIVER = "postgres";
process.env.STORAGE_MODE = "relational";
process.env.SHIPPING_CACHE_TTL_MS = "0";
process.env.SKIP_FX_REFRESH = "1";

const fs = require("node:fs");
const path = require("node:path");

const { loadLocalEnv } = require("../../src/lib/env");
const { assertProd } = require("../relational/prod-guard");
const { closeDatabase } = require("../../src/lib/db");
const store = require("../../src/lib/store");

const GENERATED_FROM =
  "prod-readonly-snapshot 2026-07-13 post batch-2 tarifario fixes (sanitized pricing structures; no credentials)";
const FIXTURE_PATH = path.join(__dirname, "fixtures", "prod-snapshot-20260713-batch2.json");

function projectLine(line) {
  return {
    id: line.id,
    name: line.name,
    containerGroups: (line.containerGroups || []).map((group) => ({
      key: group.key,
      label: group.label,
    })),
    localCharges: (line.localCharges || []).map((charge) => ({
      id: charge.id,
      concept: charge.concept,
      note: charge.note ?? null,
      taxRate: charge.taxRate,
      blRate: charge.blRate ?? null,
      groupRates: charge.groupRates ?? {},
    })),
    demurrage: {
      calculationMode: line.demurrage?.calculationMode,
      freeDays: line.demurrage?.freeDays,
      rulesByGroup: line.demurrage?.rulesByGroup,
      ruleSets: line.demurrage?.ruleSets,
      assignmentsByContainerType: line.demurrage?.assignmentsByContainerType,
    },
    guarantee: {
      benefitEnabled: line.guarantee?.benefitEnabled,
      benefitExpiresAt: line.guarantee?.benefitExpiresAt ?? null,
      benefitNote: line.guarantee?.benefitNote ?? null,
      taxRate: line.guarantee?.taxRate,
      ratesByGroup: line.guarantee?.ratesByGroup ?? {},
      fallbackRatesByGroup: line.guarantee?.fallbackRatesByGroup ?? {},
      blRate: line.guarantee?.blRate ?? null,
    },
  };
}

async function main() {
  loadLocalEnv();
  const ref = assertProd(process.env.DATABASE_URL);
  console.log(`prod ref verified: ${ref} — READ-ONLY dump`);

  const previous = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  if (previous?.exchangeRates?.provider !== "golden-pin") {
    throw new Error(`existing fixture at ${FIXTURE_PATH} has no golden-pin exchangeRates; refusing to dump`);
  }

  store.invalidateShippingDataCache();
  const data = await store.getShippingData();
  const handover = data.modules.handover;

  const fixture = {
    generatedFrom: GENERATED_FROM,
    exchangeRates: previous.exchangeRates,
    modules: {
      handover: {
        settings: {
          defaultQuoteCurrency: handover.settings?.defaultQuoteCurrency,
          defaultPriceMode: handover.settings?.defaultPriceMode,
          containerTypeMasterVersion: handover.settings?.containerTypeMasterVersion,
        },
        containerTypes: (handover.containerTypes || []).map((type) => ({
          key: type.key,
          label: type.label,
          rateGroup: type.rateGroup,
        })),
        shippingLines: (handover.shippingLines || []).map(projectLine),
      },
    },
  };

  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `wrote ${FIXTURE_PATH} (${fixture.modules.handover.shippingLines.length} lines, exchangeRates inherited: ${previous.exchangeRates.provider} ${previous.exchangeRates.asOfDate})`
  );
  await closeDatabase();
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  try {
    await closeDatabase();
  } catch {}
  process.exit(1);
});
