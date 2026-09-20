(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuotePricing = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_ROWS = 100;
  const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
  const CURRENCIES = ["USD", "MXN"];
  const CARGO_TYPES = ["FCL", "LCL", "BBK", "AIR"];
  const METHODS = ["raw_max", "volumetric", "manual"];
  const PACKAGE_FIELDS = ["lengthCm", "widthCm", "heightCm", "packageCount", "weightKg", "weightCount"];

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function present(value) {
    return value !== "" && value != null && !(typeof value === "string" && !value.trim());
  }

  function errorList(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return ["pricing:invalid_errors"];
    const errors = value.filter((error) => typeof error === "string").slice(0, 1000).map((error) => error.slice(0, 200));
    if (value.length > 1000) errors.push("pricing:too_many_errors");
    if (value.some((error) => typeof error !== "string")) errors.push("pricing:invalid_errors");
    return errors;
  }

  // Blank is distinct from an explicitly entered zero. Rejected inputs retain
  // validation errors across normalization instead of becoming usable zeroes.
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

  function normalizeCargoPricing(value, cargoType) {
    const input = object(value);
    const errors = errorList(input.validationErrors);
    if (value !== undefined && input !== value) errors.push("pricing:invalid_object");
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
    const defaultMethod = cargoType === "AIR" ? "manual" : "raw_max";
    const method = METHODS.includes(input.method) ? input.method : defaultMethod;
    if (present(input.method) && !METHODS.includes(input.method)) errors.push("method:invalid_method");
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
      method,
      manualChargeable: normalizeNumber(input.manualChargeable, false, "manualChargeable"),
      volumeDivisor: normalizeNumber(input.volumeDivisor, false, "volumeDivisor"),
    };
    if (errors.length) normalized.validationErrors = [...new Set(errors)];
    return normalized;
  }

  // The map contains at most the four supported modes and one reserved error
  // field. Keep failures explicit even when an unknown mode cannot be retained.
  function normalizeCargoPricingByType(value) {
    const input = object(value);
    const errors = errorList(input._validationErrors).map((error) => error.startsWith("cargoPricingByType:")
      ? error : `cargoPricingByType:${error.startsWith("pricing:") ? error.slice("pricing:".length) : "invalid_errors"}`);
    if (value !== undefined && input !== value) errors.push("cargoPricingByType:invalid_object");
    const output = {};
    for (const key of Object.keys(input)) {
      if (key === "_validationErrors") continue;
      if (!CARGO_TYPES.includes(key)) {
        errors.push("cargoPricingByType:unsupported_type");
        continue;
      }
      output[key] = normalizeCargoPricing(input[key], key);
    }
    if (errors.length) output._validationErrors = [...new Set(errors)];
    return output;
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

  function structuralError(error) {
    return /^(?:cargoPricingByType|pricing):/.test(error) || /:(?:invalid_rows|too_many_rows|invalid_row)$/.test(error);
  }

  function activeErrors(type, pricing) {
    return (pricing.validationErrors || []).filter((error) => {
      if (/^(?:cargoPricingByType|pricing):/.test(error)) return true;
      if (type === "FCL") return error.startsWith("containers");
      if (error.startsWith("containers")) return false;
      if (error.startsWith("packages")) return pricing.method !== "manual" || structuralError(error);
      if (error.startsWith("manualChargeable")) return pricing.method === "manual";
      if (error.startsWith("volumeDivisor")) return pricing.method === "volumetric";
      return true;
    });
  }

  function cargoPricingAttempted(cargoType, value) {
    const type = typeof cargoType === "string" ? cargoType.trim().toUpperCase() : "";
    if (!CARGO_TYPES.includes(type)) return false;
    const pricing = normalizeCargoPricing(value, type);
    const errors = activeErrors(type, pricing);
    if (errors.some(structuralError)) return true;
    // Cargo details without a transport price are descriptive. They do not
    // block quotes whose fees have been entered independently by the operator.
    return type === "FCL"
      ? pricing.containers.some((row) => present(row.unitPrice)) || errors.some((error) => /^containers\.\d+\.unitPrice:/.test(error))
      : present(pricing.unitPrice) || errors.some((error) => error.startsWith("unitPrice:"));
  }

  function packageTotals(pricing) {
    const errors = (pricing.validationErrors || []).filter((error) => error.startsWith("packages"));
    let active = 0;
    let totalWeightKg = 0;
    let totalVolumeCm3 = 0;
    pricing.packages.forEach((row, index) => {
      if (!PACKAGE_FIELDS.some((key) => present(row[key]))) return;
      active += 1;
      const prefix = `packages.${index}`;
      PACKAGE_FIELDS.forEach((key) => {
        if (row[key] === "" || (key.endsWith("Count") && row[key] < 1)) {
          errors.push(`${prefix}.${key}:${key.endsWith("Count") ? "positive_integer_required" : "nonnegative_number_required"}`);
        }
      });
      if (PACKAGE_FIELDS.some((key) => row[key] === "")) return;
      const volume = safeProduct([row.lengthCm, row.widthCm, row.heightCm, row.packageCount]);
      const weight = safeProduct([row.weightKg, row.weightCount]);
      if (volume === null || weight === null || totalWeightKg + weight > MAX_NUMBER || totalVolumeCm3 + volume > MAX_NUMBER) {
        errors.push(`${prefix}.total:overflow`);
        return;
      }
      totalWeightKg += weight;
      totalVolumeCm3 += volume;
    });
    if (!active) errors.push("packages:at_least_one_required");
    return { errors, totalWeightKg, totalVolumeCm3 };
  }

  function calculateCargoPricing(cargoType, value) {
    const type = typeof cargoType === "string" ? cargoType.trim().toUpperCase() : "";
    const pricing = normalizeCargoPricing(value, type);
    const method = type === "FCL" ? "container" : pricing.method;
    const result = {
      valid: false,
      errors: activeErrors(type, pricing),
      totalWeightKg: null,
      totalVolumeCm3: null,
      chargeableValue: null,
      method,
      basis: type === "FCL" ? "container" : method === "manual" ? "manual_chargeable" : method === "volumetric" ? "volumetric_weight" : "raw_max_kg_cm3",
      volumeDivisor: pricing.volumeDivisor,
      unitPrice: pricing.unitPrice,
      currency: pricing.currency,
      rows: [],
      subtotals: [],
    };
    if (!CARGO_TYPES.includes(type)) {
      result.errors.push("cargoType:unsupported");
      return result;
    }
    const rows = [];
    if (type === "FCL") {
      let active = 0;
      pricing.containers.forEach((row, index) => {
        if (!["containerType", "quantity", "unitPrice"].some((key) => present(row[key]))) return;
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
      const totals = packageTotals(pricing);
      if (!totals.errors.length) {
        result.totalWeightKg = totals.totalWeightKg;
        result.totalVolumeCm3 = totals.totalVolumeCm3;
      }
      if (method === "manual") {
        if (pricing.manualChargeable === "") result.errors.push("manualChargeable:nonnegative_number_required");
        else result.chargeableValue = pricing.manualChargeable;
      } else {
        result.errors.push(...totals.errors);
        if (method === "volumetric" && (pricing.volumeDivisor === "" || pricing.volumeDivisor <= 0)) {
          result.errors.push("volumeDivisor:positive_number_required");
        }
        if (!totals.errors.length) {
          if (method === "raw_max") {
            // Retained user-confirmed rule: compare raw kg and cm³ numbers.
            result.chargeableValue = Math.max(totals.totalWeightKg, totals.totalVolumeCm3);
          } else if (pricing.volumeDivisor !== "" && pricing.volumeDivisor > 0) {
            const volumetricWeight = totals.totalVolumeCm3 / pricing.volumeDivisor;
            if (!Number.isFinite(volumetricWeight) || volumetricWeight > MAX_NUMBER) result.errors.push("volumetricWeight:overflow");
            else result.chargeableValue = Math.max(totals.totalWeightKg, volumetricWeight);
          }
        }
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
    result.errors = [...new Set(result.errors)];
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

  return { normalizeCargoPricing, normalizeCargoPricingByType, cargoPricingAttempted, calculateCargoPricing };
});
