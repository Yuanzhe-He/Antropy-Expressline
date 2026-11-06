(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuoteChargePricing = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_MONEY = Number.MAX_SAFE_INTEGER / 100;
  const present = (value) => value != null && !(typeof value === "string" && !value.trim());
  const unique = (values) => [...new Set(values)];

  function parseNonnegative(value, field, errors) {
    if (!present(value)) return null;
    if ((typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" && !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) {
      errors.push(`${field}:invalid_number`); return null;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > MAX_MONEY) {
      errors.push(`${field}:invalid_number`); return null;
    }
    return number;
  }

  function normalizeChargePricing(value = {}) {
    const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const errors = Array.isArray(item.pricingErrors)
      ? item.pricingErrors.filter((error) => typeof error === "string").slice(0, 30).map((error) => error.slice(0, 120)) : [];
    if (item.pricingErrors !== undefined && !Array.isArray(item.pricingErrors)) errors.push("pricingErrors:invalid_errors");
    const priceType = item.priceType === "percentage" ? "percentage" : "amount";
    if (present(item.priceType) && !["amount", "percentage"].includes(item.priceType)) errors.push("priceType:invalid_type");
    const percentageRate = parseNonnegative(item.percentageRate, "percentageRate", errors);
    const cargoValue = parseNonnegative(item.cargoValue, "cargoValue", errors);
    if (priceType === "percentage") {
      if (item.isAtCost === true || String(item.unitPrice || "").trim().toUpperCase() === "AT COST") errors.push("percentage:at_cost_conflict");
      if (present(item.unitPriceMax)) errors.push("percentage:range_conflict");
    }
    return { priceType, percentageRate, cargoValue, pricingErrors: unique(errors) };
  }

  function formatRate(value) {
    return value == null ? "—" : `${Number(value).toLocaleString("en-US", { maximumFractionDigits: 20, useGrouping: false })}%`;
  }

  function money(value, errors) {
    if (!Number.isFinite(value) || value < 0 || value > MAX_MONEY) {
      errors.push("total:overflow"); return null;
    }
    const unroundedCents = value * 100;
    const cents = Math.round(unroundedCents + Number.EPSILON * Math.max(1, Math.abs(unroundedCents)));
    if (!Number.isSafeInteger(cents)) { errors.push("total:overflow"); return null; }
    return cents / 100;
  }

  // A percentage is one charge on the entered goods value in the fee currency.
  // It is never multiplied by the unit/container quantity a second time.
  function calculateCharge(item = {}) {
    const normalized = normalizeChargePricing(item);
    const errors = [...normalized.pricingErrors];
    const result = { ...normalized, total: null, totalMax: null, status: "pending", errors,
      rateLabel: normalized.priceType === "percentage" ? formatRate(normalized.percentageRate) : "" };
    if (normalized.priceType === "percentage") {
      if (!errors.length && normalized.percentageRate !== null && normalized.cargoValue !== null) {
        result.total = money(normalized.cargoValue * (normalized.percentageRate / 100), errors);
      }
    } else if (item.isAtCost === true || String(item.unitPrice || "").trim().toUpperCase() === "AT COST") {
      result.status = "atcost";
    } else {
      const quantity = parseNonnegative(item.unit, "unit", errors);
      const price = parseNonnegative(item.unitPrice, "unitPrice", errors);
      const upper = parseNonnegative(item.unitPriceMax, "unitPriceMax", errors);
      if (upper !== null && (price === null || upper < price)) errors.push("unitPriceMax:invalid_range");
      if (!errors.length && quantity !== null && price !== null) {
        result.total = money(quantity * price, errors);
        if (upper !== null && upper > price) result.totalMax = money(quantity * upper, errors);
      }
    }
    result.errors = unique(errors);
    if (result.errors.length) {
      result.status = "invalid";
      result.total = null; result.totalMax = null;
    } else if (result.total !== null) result.status = "amount";
    return result;
  }

  return { normalizeChargePricing, calculateCharge, formatRate };
});
