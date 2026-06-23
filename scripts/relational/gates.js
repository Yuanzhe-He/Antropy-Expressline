// Pre-migration data gates (run on the normalized blob before decompose). Both
// FAIL LOUD: a hit must STOP the migration for reconciliation, never silently
// coerce/drop. Reused by the sandbox forward migration and the prod cutover.

const ALLOWED_CURRENCIES = new Set(["MXN", "USD"]);
const CURRENCY_KEYS = new Set([
  "currency",
  "amountCurrency",
  "quoteCurrency",
  "defaultQuoteCurrency",
  "indicativeCurrency",
  "base",
  "quote",
]);

// Q5: every currency-bearing field must be MXN or USD. Returns { ok, violations }.
function currencyGate(blob) {
  const violations = [];
  (function walk(node, path) {
    if (!node || typeof node !== "object") {
      return;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (
        CURRENCY_KEYS.has(key) &&
        typeof value === "string" &&
        value.trim() &&
        !ALLOWED_CURRENCIES.has(value.trim().toUpperCase())
      ) {
        violations.push({ path: `${path}/${key}`, value });
      }
      walk(value, `${path}/${key}`);
    }
  })(blob, "");
  return { ok: violations.length === 0, violations };
}

// Q4: the customs shippingLines mirror collapses into carriers + yard_carriers,
// so every yard.shippingLineIds / customs line id / customs line.yardIds must
// resolve to a real carrier / handover line / yard. An orphan would be silently
// dropped by the FK — stop and reconcile first. Returns { ok, orphans }.
function orphanGate(blob) {
  const modules = blob?.modules || {};
  const handover = modules.handover || {};
  const customs = modules.customs || {};
  const carrierIds = new Set((handover.shippingLines || []).map((l) => l.id));
  const yardIds = new Set((customs.yards || []).map((y) => y.id));
  const orphans = [];

  for (const yard of customs.yards || []) {
    for (const id of yard.shippingLineIds || []) {
      if (!carrierIds.has(id)) {
        orphans.push({ kind: "yard.shippingLineIds→carrier", yard: yard.id, ref: id });
      }
    }
  }
  for (const line of customs.shippingLines || []) {
    if (!carrierIds.has(line.id)) {
      orphans.push({ kind: "customs.shippingLines.id→handover", ref: line.id });
    }
    for (const yid of line.yardIds || []) {
      if (!yardIds.has(yid)) {
        orphans.push({ kind: "customs.line.yardIds→yard", line: line.id, ref: yid });
      }
    }
  }
  return { ok: orphans.length === 0, orphans };
}

// Run both; print a report. Returns true iff both pass.
function runGates(blob, label = "blob") {
  const cur = currencyGate(blob);
  const orph = orphanGate(blob);
  console.log(
    `[gates:${label}] Q5 currency: ${cur.ok ? "PASS" : `FAIL (${cur.violations.length})`}` +
      ` | Q4 orphan: ${orph.ok ? "PASS" : `FAIL (${orph.orphans.length})`}`
  );
  if (!cur.ok) {
    console.error("[gates] Q5 currency violations:", JSON.stringify(cur.violations.slice(0, 20)));
  }
  if (!orph.ok) {
    console.error("[gates] Q4 orphans:", JSON.stringify(orph.orphans.slice(0, 20)));
  }
  return cur.ok && orph.ok;
}

module.exports = { currencyGate, orphanGate, runGates };
