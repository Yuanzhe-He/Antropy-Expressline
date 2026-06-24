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

// Migration normalization (the DROP reconcile, 2026-06-23): remove ONLY carrier↔yard
// references whose TARGET ID does not exist (the target was deleted → the reference is
// a dangling pointer → lossless to drop). Mutates the blob in place and returns the
// list of dropped refs for an auditable, per-ref log. Crucially this does NOT touch
// any other orphan class (e.g. a mirror line whose id isn't in handover): those
// survive and the Q4 gate (run AFTER this) still aborts on them — so a "target exists
// but mis-bucketed" orphan is never silently swallowed.
function dropDanglingRefs(blob) {
  const customs = blob?.modules?.customs || {};
  const handover = blob?.modules?.handover || {};
  const yardIds = new Set((customs.yards || []).map((y) => y.id));
  const carrierIds = new Set((handover.shippingLines || []).map((l) => l.id));
  const dropped = [];

  for (const line of customs.shippingLines || []) {
    if (!Array.isArray(line.yardIds)) continue;
    const kept = [];
    for (const id of line.yardIds) {
      if (yardIds.has(id)) kept.push(id);
      else dropped.push({ kind: "customs.line.yardIds→deletedYard", owner: line.id, ref: id });
    }
    line.yardIds = kept;
  }
  for (const yard of customs.yards || []) {
    if (!Array.isArray(yard.shippingLineIds)) continue;
    const kept = [];
    for (const id of yard.shippingLineIds) {
      if (carrierIds.has(id)) kept.push(id);
      else dropped.push({ kind: "yard.shippingLineIds→deletedCarrier", owner: yard.id, ref: id });
    }
    yard.shippingLineIds = kept;
  }
  return { dropped };
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

module.exports = { currencyGate, orphanGate, runGates, dropDanglingRefs };
