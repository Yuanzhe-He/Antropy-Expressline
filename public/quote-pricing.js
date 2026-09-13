(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuotePricing = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_ROWS = 100;
  const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
  const CURRENCIES = ["USD", "MXN"];
  const PACKAGE_FIELDS = ["lengthCm", "widthCm", "heightCm", "packageCount", "weightKg", "weightCount"];

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  // Blank is distinct from an explicitly entered zero. Invalid input stays
  // unpriced rather than being silently coerced to zero or an integer.
  function number(value, integer) {
    if (value === "" || value == null) return "";
    if (typeof value !== "number" && typeof value !== "string") return "";
    if (typeof value === "string") {
      value = value.trim();
      if (!value || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return "";
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_NUMBER) return "";
    if (integer && !Number.isSafeInteger(parsed)) return "";
    return parsed;
  }

  function currency(value) {
    const code = typeof value === "string" ? value.trim().toUpperCase() : "";
    return CURRENCIES.includes(code) ? code : "";
  }

  function normalizeCargoPricing(value) {
    const input = object(value);
    const errors = Array.isArray(input.validationErrors)
      ? input.validationErrors.filter((error) => typeof error === "string").slice(0, 100).map((error) => error.slice(0, 200)) : [];
    const normalizeNumber = (value, integer, field) => {
      const normalized = number(value, integer);
      if (present(value) && normalized === "") errors.push(`${field}:invalid_number`);
      return normalized;
    };
    const normalizeCurrency = (value, field) => {
      const normalized = currency(value);
      if (present(value) && !normalized) errors.push(`${field}:invalid_currency`);
      return normalized;
    };
    for (const key of ["containers", "packages"]) {
      if (input[key] != null && !Array.isArray(input[key])) errors.push(`${key}:invalid_rows`);
      if (Array.isArray(input[key]) && input[key].length > MAX_ROWS) errors.push(`${key}:too_many_rows`);
    }
    const normalized = {
      containers: (Array.isArray(input.containers) ? input.containers : []).slice(0, MAX_ROWS).map((value, index) => {
        const row = object(value);
        if (row !== value) errors.push(`containers.${index}:invalid_row`);
        return {
          containerType: typeof row.containerType === "string" ? row.containerType.trim().slice(0, 40) : "",
          quantity: normalizeNumber(row.quantity, true, `containers.${index}.quantity`),
          unitPrice: normalizeNumber(row.unitPrice, false, `containers.${index}.unitPrice`),
          currency: normalizeCurrency(row.currency, `containers.${index}.currency`),
        };
      }),
      packages: (Array.isArray(input.packages) ? input.packages : []).slice(0, MAX_ROWS).map((value, index) => {
        const row = object(value);
        if (row !== value) errors.push(`packages.${index}:invalid_row`);
        return Object.fromEntries(PACKAGE_FIELDS.map((key) => [key, normalizeNumber(row[key], key.endsWith("Count"), `packages.${index}.${key}`)]));
      }),
      unitPrice: normalizeNumber(input.unitPrice, false, "unitPrice"),
      currency: normalizeCurrency(input.currency, "currency"),
    };
    // Keep rejected input visible to server-side validation even when a parsed
    // header is normalized before calculation. The browser replaces this list
    // by collecting a fresh form value once a user corrects an invalid input.
    if (errors.length) normalized.validationErrors = [...new Set(errors)];
    return normalized;
  }

  function present(value) {
    return value !== "" && value != null && !(typeof value === "string" && !value.trim());
  }

  function safeProduct(values) {
    const result = values.reduce((product, value) => product * value, 1);
    return Number.isFinite(result) && result >= 0 && result <= MAX_NUMBER ? result : null;
  }

  function money(value) {
    if (!Number.isFinite(value) || value < 0 || value > MAX_NUMBER / 100) return null;
    const cents = value * 100;
    const rounded = Math.round(cents + Number.EPSILON * Math.max(1, Math.abs(cents)));
    return Number.isSafeInteger(rounded) ? rounded / 100 : null;
  }

  function calculateCargoPricing(cargoType, value) {
    const type = typeof cargoType === "string" ? cargoType.trim().toUpperCase() : "";
    const raw = object(value);
    const pricing = normalizeCargoPricing(raw);
    const result = {
      valid: false,
      errors: (pricing.validationErrors || []).filter((error) => type === "FCL"
        ? error.startsWith("containers")
        : !error.startsWith("containers")),
      totalWeightKg: null,
      totalVolumeCm3: null,
      chargeableValue: null,
      basis: type === "FCL" ? "container" : "raw_max_kg_cm3",
      unitPrice: pricing.unitPrice,
      currency: pricing.currency,
      rows: [],
      subtotals: [],
    };
    if (!["FCL", "LCL", "BBK"].includes(type)) {
      result.errors.push("cargoType:unsupported");
      return result;
    }
    const inputRows = type === "FCL" ? raw.containers : raw.packages;
    if (inputRows != null && !Array.isArray(inputRows)) result.errors.push("rows:invalid");
    if (Array.isArray(inputRows) && inputRows.length > MAX_ROWS) result.errors.push("rows:too_many");

    const rows = [];
    if (type === "FCL") {
      let active = 0;
      pricing.containers.forEach((row, index) => {
        const original = object(raw.containers[index]);
        if (!["containerType", "quantity", "unitPrice"].some((key) => present(original[key]))) return;
        active += 1;
        const prefix = `containers.${index}`;
        if (!row.containerType) result.errors.push(`${prefix}.containerType:required`);
        if (row.quantity === "" || row.quantity < 1) result.errors.push(`${prefix}.quantity:positive_integer_required`);
        if (row.unitPrice === "") result.errors.push(`${prefix}.unitPrice:nonnegative_number_required`);
        if (!row.currency) result.errors.push(`${prefix}.currency:required`);
        if (row.quantity !== "" && row.unitPrice !== "") {
          const product = safeProduct([row.quantity, row.unitPrice]);
          const total = product === null ? null : money(product);
          if (total === null) result.errors.push(`${prefix}.total:overflow`);
          else rows.push({ ...row, total });
        }
      });
      if (!active) result.errors.push("containers:at_least_one_required");
    } else {
      let active = 0;
      let totalWeightKg = 0;
      let totalVolumeCm3 = 0;
      const quantityErrorCount = result.errors.length;
      pricing.packages.forEach((row, index) => {
        const original = object(raw.packages[index]);
        if (!PACKAGE_FIELDS.some((key) => present(original[key]))) return;
        active += 1;
        const prefix = `packages.${index}`;
        PACKAGE_FIELDS.forEach((key) => {
          if (row[key] === "" || (key.endsWith("Count") && row[key] < 1)) {
            result.errors.push(`${prefix}.${key}:${key.endsWith("Count") ? "positive_integer_required" : "nonnegative_number_required"}`);
          }
        });
        if (PACKAGE_FIELDS.some((key) => row[key] === "")) return;
        const volume = safeProduct([row.lengthCm, row.widthCm, row.heightCm, row.packageCount]);
        const weight = safeProduct([row.weightKg, row.weightCount]);
        if (volume === null || weight === null || totalWeightKg + weight > MAX_NUMBER || totalVolumeCm3 + volume > MAX_NUMBER) {
          result.errors.push(`${prefix}.total:overflow`);
          return;
        }
        totalWeightKg += weight;
        totalVolumeCm3 += volume;
      });
      if (!active) result.errors.push("packages:at_least_one_required");
      if (active && result.errors.length === quantityErrorCount && quantityErrorCount === 0) {
        result.totalWeightKg = totalWeightKg;
        result.totalVolumeCm3 = totalVolumeCm3;
        // Explicit user-confirmed rule (2026-09-13): compare the raw kg and cm³
        // numeric totals. There is deliberately NO volumetric-weight divisor.
        result.chargeableValue = Math.max(totalWeightKg, totalVolumeCm3);
      }
      if (pricing.unitPrice === "") result.errors.push("unitPrice:nonnegative_number_required");
      if (!pricing.currency) result.errors.push("currency:required");
      if (result.chargeableValue !== null && pricing.unitPrice !== "") {
        const product = safeProduct([result.chargeableValue, pricing.unitPrice]);
        const total = product === null ? null : money(product);
        if (total === null) result.errors.push("total:overflow");
        else rows.push({ containerType: type, quantity: result.chargeableValue, unitPrice: pricing.unitPrice, currency: pricing.currency, total });
      }
    }

    if (result.errors.length) return result;
    const subtotals = [];
    for (const row of rows) {
      let subtotal = subtotals.find((entry) => entry.currency === row.currency);
      if (!subtotal) {
        subtotal = { currency: row.currency, amount: 0 };
        subtotals.push(subtotal);
      }
      const amount = money(subtotal.amount + row.total);
      if (amount === null) {
        result.errors.push(`subtotals.${row.currency}:overflow`);
        return result;
      }
      subtotal.amount = amount;
    }
    result.valid = true;
    result.rows = rows;
    result.subtotals = subtotals;
    if (subtotals.length === 1) result.total = subtotals[0].amount;
    return result;
  }

  return { normalizeCargoPricing, calculateCargoPricing };
});
