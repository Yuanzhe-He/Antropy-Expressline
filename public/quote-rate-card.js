(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuoteRateCard = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TYPES = ["FCL", "LCL", "BBK", "AIR"];
  const GROUPS = ["OCEAN FREIGHT", "PORT OF ORIGIN", "SHIPPING LINE", "PORT FEES", "CUSTOMS CLEARANCE", "TRANSPORTATION", "DUTY"];
  const RESERVED = [...Object.getOwnPropertyNames(Object.prototype).map((key) => key.toLowerCase()), "prototype"];
  const MAX_VARIANTS = 12;
  const MAX_ROWS = 100;
  const MAX_JSON_BYTES = 1024 * 1024;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const empty = (value) => value == null || (typeof value === "string" && !value.trim());
  const unique = (errors) => [...new Set(errors)];
  const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value) && !RESERVED.includes(value.toLowerCase());

  function inheritedErrors(value, prefix) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return [`${prefix}:invalid_errors`];
    const errors = value.filter((entry) => typeof entry === "string").slice(0, 1000).map((entry) => entry.slice(0, 240));
    if (value.some((entry) => typeof entry !== "string")) errors.push(`${prefix}:invalid_errors`);
    if (value.length > 1000) errors.push(`${prefix}:too_many_errors`);
    return errors;
  }

  function text(value, limit, field, errors) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") { errors.push(`${field}:invalid_text`); return ""; }
    const result = value.trim();
    if (result.length > limit) errors.push(`${field}:too_long`);
    return result;
  }

  function price(value, field, errors) {
    if (empty(value)) return null;
    if ((typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" && !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) {
      errors.push(`${field}:invalid_number`); return null;
    }
    const result = Number(value);
    if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER / 100) {
      errors.push(`${field}:invalid_number`); return null;
    }
    return result;
  }

  function flag(value, fallback, field, errors) {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") { errors.push(`${field}:invalid_boolean`); return fallback; }
    return value;
  }

  function rejectPrototypeKeys(value, prefix, errors) {
    if (!isObject(value)) return;
    for (const key of Object.keys(value)) {
      if (RESERVED.includes(key.toLowerCase())) errors.push(`${prefix}:unsafe_key`);
    }
  }

  function normalizeQuoteType(value) {
    return value === "long_term" ? "long_term" : "single";
  }

  function normalizeCell(value, field, errors) {
    if (value == null) return { unitPrice: null, unitPriceMax: null, isAtCost: false };
    const input = isObject(value) ? value : {};
    if (input !== value) errors.push(`${field}:invalid_cell`);
    rejectPrototypeKeys(input, field, errors);
    const cell = {
      unitPrice: price(input.unitPrice, `${field}.unitPrice`, errors),
      unitPriceMax: price(input.unitPriceMax, `${field}.unitPriceMax`, errors),
      isAtCost: flag(input.isAtCost, false, `${field}.isAtCost`, errors),
    };
    if (cell.unitPriceMax !== null && (cell.unitPrice === null || cell.unitPriceMax < cell.unitPrice)) {
      errors.push(`${field}.unitPriceMax:invalid_range`);
    }
    return cell;
  }

  function normalizeRateCard(value) {
    const input = isObject(value) ? value : {};
    const errors = inheritedErrors(input.validationErrors, "card");
    if (value !== undefined && input !== value) errors.push("card:invalid_object");
    rejectPrototypeKeys(input, "card", errors);
    if (input.variants !== undefined && !Array.isArray(input.variants)) errors.push("variants:invalid_variants");
    if (input.rows !== undefined && !Array.isArray(input.rows)) errors.push("rows:invalid_rows");
    const variantsIn = Array.isArray(input.variants) ? input.variants : [];
    const rowsIn = Array.isArray(input.rows) ? input.rows : [];
    if (variantsIn.length > MAX_VARIANTS) errors.push("variants:too_many_variants");
    if (rowsIn.length > MAX_ROWS) errors.push("rows:too_many_rows");
    // Do not silently truncate a user's matrix. Oversized input stays available
    // for an explicit deletion, while save/export validation rejects it. Avoid
    // expanding thousands of compact malformed rows into full metadata objects.
    if (variantsIn.length > MAX_VARIANTS || rowsIn.length > MAX_ROWS) {
      return { variants: variantsIn.slice(), rows: rowsIn.slice(), validationErrors: unique(errors) };
    }
    const ids = new Set();
    const labels = new Set();
    const variants = variantsIn.map((entry, index) => {
      const src = isObject(entry) ? entry : {};
      const field = `variants.${index}`;
      if (src !== entry) errors.push(`${field}:invalid_variant`);
      rejectPrototypeKeys(src, field, errors);
      const id = text(src.id, 80, `${field}.id`, errors);
      const label = text(src.label, 120, `${field}.label`, errors);
      if (!safeId(id)) errors.push(`${field}.id:invalid_id`);
      if (ids.has(id)) errors.push(`${field}.id:duplicate_id`);
      if (!label) errors.push(`${field}.label:required`);
      if (label && labels.has(label.toLocaleLowerCase())) errors.push(`${field}.label:duplicate_label`);
      ids.add(id); labels.add(label.toLocaleLowerCase());
      return { id, label };
    });
    const rowIds = new Set();
    const rows = rowsIn.map((entry, index) => {
      const src = isObject(entry) ? entry : {};
      const field = `rows.${index}`;
      if (src !== entry) errors.push(`${field}:invalid_row`);
      rejectPrototypeKeys(src, field, errors);
      const id = text(src.id, 80, `${field}.id`, errors);
      if (!safeId(id)) errors.push(`${field}.id:invalid_id`);
      if (rowIds.has(id)) errors.push(`${field}.id:duplicate_id`);
      rowIds.add(id);
      const category = src.category === undefined ? "SHIPPING LINE" : text(src.category, 40, `${field}.category`, errors);
      if (!GROUPS.includes(category)) errors.push(`${field}.category:invalid_category`);
      const section = src.section === undefined ? "mexico" : src.section;
      if (!["foreign", "mexico"].includes(section)) errors.push(`${field}.section:invalid_section`);
      const chargeKind = src.chargeKind === undefined ? "fixed" : src.chargeKind;
      if (!["fixed", "contingent"].includes(chargeKind)) errors.push(`${field}.chargeKind:invalid_charge_kind`);
      const cur = text(src.currency, 3, `${field}.currency`, errors).toUpperCase();
      if (!["USD", "MXN"].includes(cur)) errors.push(`${field}.currency:invalid_currency`);
      const row = {
        id, category,
        code: text(src.code, 80, `${field}.code`, errors),
        conceptEn: text(src.conceptEn, 300, `${field}.conceptEn`, errors),
        conceptZh: text(src.conceptZh, 300, `${field}.conceptZh`, errors),
        conceptEs: text(src.conceptEs, 300, `${field}.conceptEs`, errors),
        section, chargeKind,
        included: flag(src.included, true, `${field}.included`, errors),
        unitOfMeasure: text(src.unitOfMeasure, 80, `${field}.unitOfMeasure`, errors),
        currency: cur,
        remark: text(src.remark, 4000, `${field}.remark`, errors),
        cells: {},
      };
      if (!row.conceptEn && !row.conceptZh && !row.conceptEs) errors.push(`${field}.concept:required`);
      if (src.cells !== undefined && !isObject(src.cells)) errors.push(`${field}.cells:invalid_cells`);
      const cells = isObject(src.cells) ? src.cells : {};
      rejectPrototypeKeys(cells, `${field}.cells`, errors);
      for (const key of Object.keys(cells)) {
        if (!safeId(key) || !ids.has(key)) errors.push(`${field}.cells:unknown_variant`);
      }
      for (const variant of variants) {
        if (!safeId(variant.id)) continue;
        row.cells[variant.id] = normalizeCell(own(cells, variant.id) ? cells[variant.id] : undefined, `${field}.cells.${variant.id}`, errors);
      }
      return row;
    });
    const card = { variants, rows };
    if (errors.length) card.validationErrors = unique(errors);
    return card;
  }

  function normalizeRateCardsByType(value) {
    const input = isObject(value) ? value : {};
    const errors = inheritedErrors(input._validationErrors, "rateCardsByType");
    if (value !== undefined && input !== value) errors.push("rateCardsByType:invalid_object");
    const result = {};
    for (const key of Object.keys(input)) {
      if (key === "_validationErrors") continue;
      if (!TYPES.includes(key)) { errors.push("rateCardsByType:unsupported_type"); continue; }
      result[key] = normalizeRateCard(input[key]);
    }
    if (errors.length) result._validationErrors = unique(errors);
    return result;
  }

  function parseRateCardsByType(raw) {
    if (raw === undefined) return {};
    if (typeof raw !== "string") return { _validationErrors: ["rateCardsByType:invalid_json"] };
    // Count UTF-8 bytes in both Node and browsers, including Unicode labels,
    // without allocating another full copy of a potentially oversized body.
    let bytes = 0;
    for (const character of raw) {
      const code = character.codePointAt(0);
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (bytes > MAX_JSON_BYTES) return { _validationErrors: ["rateCardsByType:too_large"] };
    }
    try { return normalizeRateCardsByType(JSON.parse(raw)); }
    catch (_) { return { _validationErrors: ["rateCardsByType:invalid_json"] }; }
  }

  function createDefaultRateCard(cargoType, feeTemplates) {
    const variants = cargoType === "FCL"
      ? ["20GP", "40GP", "40HQ"].map((label) => ({ id: label, label }))
      : [{ id: "standard", label: "标准规格" }];
    const templates = Array.isArray(feeTemplates) ? feeTemplates : [];
    return normalizeRateCard({ variants, rows: templates.filter((row) => isObject(row) && row.enabled === true &&
      (!Array.isArray(row.appliesTo) || row.appliesTo.includes(cargoType))).map((row) => ({
      id: row.id, category: row.category, code: row.code || "",
      conceptEn: row.conceptEn, conceptZh: row.conceptZh, conceptEs: row.conceptEs,
      section: row.section || "mexico", chargeKind: row.chargeKind || "fixed",
      included: row.included !== false && !row.selectionRequired,
      unitOfMeasure: row.unitOfMeasure, currency: row.currency, remark: row.remark,
      cells: {},
    })) });
  }

  function offered(cell) {
    return Boolean(cell) && (cell.isAtCost === true || cell.unitPrice !== null);
  }

  function validateRateCard(card, options = {}) {
    const normalized = normalizeRateCard(card);
    const errors = [...(normalized.validationErrors || [])];
    if (options.forExport) {
      if (!normalized.variants.length) errors.push("variants:at_least_one_required");
      if (!normalized.rows.some((row) => row && row.included !== false && isObject(row.cells) &&
          normalized.variants.some((variant) => safeId(variant?.id) && offered(row.cells[variant.id])))) {
        errors.push("rows:at_least_one_offered_cell_required");
      }
    }
    return unique(errors);
  }

  function validateRateCardsByType(map) {
    const normalized = normalizeRateCardsByType(map);
    const errors = [...(normalized._validationErrors || [])];
    for (const type of TYPES) {
      if (own(normalized, type)) errors.push(...validateRateCard(normalized[type]).map((error) => `${type}.${error}`));
    }
    return unique(errors);
  }

  function formatPrice(value) {
    if (value === 0) return "0.00";
    if (value > 0 && value < 0.000001) return String(value);
    return Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 20 });
  }

  function buildRateCardView(card, quoteMode) {
    const normalized = normalizeRateCard(card);
    // No partial matrix should be printed when an over-limit structure cannot
    // be safely interpreted. The caller returns these errors in the editor.
    if (normalized.variants.length > MAX_VARIANTS || normalized.rows.length > MAX_ROWS) {
      return { variants: [], rows: [], chargeSections: [], errors: validateRateCard(normalized, { forExport: true }) };
    }
    const activeIndices = new Set();
    const activeRows = normalized.rows.filter((row, index) => {
      const active = row.included !== false && (quoteMode === "ocean_mexico" || row.section !== "foreign");
      if (active) activeIndices.add(index);
      return active;
    });
    const visibleErrors = (normalized.validationErrors || []).filter((error) => {
      const row = /^rows\.(\d+)\./.exec(error);
      return !row || activeIndices.has(Number(row[1]));
    });
    const effective = { variants: normalized.variants, rows: activeRows };
    // Errors on normalized-away values are retained, while off-scope row field
    // errors do not prevent exporting a different geography or excluded row.
    if (visibleErrors.length) effective.validationErrors = visibleErrors;
    const errors = validateRateCard(effective, { forExport: true });
    const rows = activeRows.map((row) => ({ ...row, unit: 1, cells: Object.fromEntries(normalized.variants.filter((variant) => safeId(variant.id)).map((variant) => {
      const cell = row.cells[variant.id];
      return [variant.id, { ...cell, offered: offered(cell), priceLabel: cell.isAtCost ? "AT COST"
        : cell.unitPrice === null ? "—" : cell.unitPriceMax !== null && cell.unitPriceMax > cell.unitPrice
          ? `${formatPrice(cell.unitPrice)}–${formatPrice(cell.unitPriceMax)}` : formatPrice(cell.unitPrice) }];
    })) }));
    const chargeSections = ["fixed", "contingent"].map((chargeKind) => ({
      chargeKind,
      sections: ["foreign", "mexico"].map((section) => ({
        section,
        groups: GROUPS.map((category) => ({ category, items: rows.filter((row) => row.chargeKind === chargeKind && row.section === section && row.category === category) }))
          .filter((group) => group.items.length),
      })).filter((section) => section.groups.length),
    }));
    return { variants: normalized.variants, rows, chargeSections, errors };
  }

  return { normalizeQuoteType, normalizeRateCard, normalizeRateCardsByType, parseRateCardsByType,
    createDefaultRateCard, validateRateCard, validateRateCardsByType, buildRateCardView };
});
