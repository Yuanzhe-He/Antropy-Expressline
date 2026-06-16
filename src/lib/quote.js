const fs = require("node:fs");
const path = require("node:path");

// Bump to (re)seed modules.quote.templateRows / notes from the constants below.
const QUOTE_TEMPLATE_VERSION = 1;

// Fixed group order for the MEXICO LOCAL CHARGES table (spec §3 / report §C).
const QUOTE_GROUP_ORDER = Object.freeze([
  "SHIPPING LINE",
  "PORT FEES",
  "CUSTOMS CLEARANCE",
  "TRANSPORTATION",
  "DUTY",
]);

// The 11 default rows mirror docs/reference/quote-template-spec.md §3.
// source: calc -> pulled from a calculator (calcRef points at it); manual ->
// editable default; atcost -> shown as "AT COST", never priced.
const QUOTE_TEMPLATE_ROWS = Object.freeze([
  {
    category: "SHIPPING LINE",
    code: "D/O FEE",
    conceptEn: "DELIVERY ORDER FEE",
    conceptZh: "换单费",
    unit: 1,
    unitPrice: "AT COST",
    currency: "MXN",
    remark: "Unreasonable shipping charges will be reimbursed.",
    isAtCost: true,
    source: "atcost",
    calcRef: null,
  },
  {
    category: "SHIPPING LINE",
    code: "DESTINATION HANDLING FEE",
    conceptEn: "DESTINATION HANDLING FEE",
    conceptZh: "换单服务费",
    unit: 1,
    unitPrice: 1000,
    currency: "MXN",
    remark: "per container",
    isAtCost: false,
    source: "manual",
    calcRef: null,
  },
  {
    category: "SHIPPING LINE",
    code: "",
    conceptEn: "DESTINATION CONTAINER DETENTION",
    conceptZh: "目的港集装箱超期费",
    unit: 1,
    unitPrice: "AT COST",
    currency: "USD",
    remark: "The default free time for container usage is 21 days",
    isAtCost: true,
    source: "calc",
    calcRef: { module: "handover", field: "demurrage" },
  },
  {
    category: "PORT FEES",
    code: "DPCH",
    conceptEn: "DESTINATION PORT CHARGES",
    conceptZh: "目的港码头操作费",
    unit: 1,
    unitPrice: "AT COST",
    currency: "MXN",
    remark: "per container",
    isAtCost: true,
    source: "calc",
    calcRef: { module: "customs", field: "terminalFixed" },
  },
  {
    category: "PORT FEES",
    code: "DSTR",
    conceptEn: "DESTINATION YARD STORAGE FEE",
    conceptZh: "目的港堆存费",
    unit: 1,
    unitPrice: "AT COST",
    currency: "MXN",
    remark: "7 days free storage included. Charges apply beyond free time",
    isAtCost: true,
    source: "calc",
    calcRef: { module: "customs", field: "terminalStorage" },
  },
  {
    category: "CUSTOMS CLEARANCE",
    code: "CCLR",
    conceptEn: "IMPORT CUSTOMS CLEARANCE",
    conceptZh: "进口清关服务费",
    unit: 1,
    unitPrice: 6000,
    currency: "MXN",
    remark: "Each customs declaration / commercial invoice",
    isAtCost: false,
    source: "manual",
    calcRef: null,
  },
  {
    category: "TRANSPORTATION",
    code: "",
    conceptEn: "SINGLE",
    conceptZh: "单拖",
    unit: 1,
    unitPrice: 68000,
    currency: "MXN",
    remark: "Weight ≤ 25 tons",
    isAtCost: false,
    source: "calc",
    calcRef: { module: "inland", field: "sencillo" },
  },
  {
    category: "TRANSPORTATION",
    code: "",
    conceptEn: "FULL",
    conceptZh: "双拖",
    unit: 1,
    unitPrice: 96000,
    currency: "MXN",
    remark: "Weight ≤ 45 tons",
    isAtCost: false,
    source: "calc",
    calcRef: { module: "inland", field: "full" },
  },
  {
    category: "TRANSPORTATION",
    code: "",
    conceptEn: "DESTINATION OVER WEIGHT CHARGE",
    conceptZh: "超重费",
    unit: 1,
    unitPrice: 5000,
    currency: "MXN",
    remark: "Per ton / Up to 5 tons",
    isAtCost: false,
    source: "manual",
    calcRef: null,
  },
  {
    category: "TRANSPORTATION",
    code: "",
    conceptEn: "DESTINATION DETENTION",
    conceptZh: "压车费",
    unit: 1,
    unitPrice: 6000,
    currency: "MXN",
    remark: "12 hours of free loading/unloading time per container per day",
    isAtCost: false,
    source: "manual",
    calcRef: null,
  },
  {
    category: "DUTY",
    code: "PEDIMENTO",
    conceptEn: "PEDIMENTO",
    conceptZh: "进口税金",
    unit: null,
    unitPrice: "AT COST",
    currency: "",
    remark: "Payment to the customs broker / PECE",
    isAtCost: true,
    source: "atcost",
    calcRef: null,
  },
]);

// Bilingual fixed clauses (spec §4). Decoupled from the app's zh/es i18n (D3):
// the quote document is always EN + 中文.
const QUOTE_NOTES = Object.freeze([
  {
    // K5 (20260614): provisional wording for the dual-currency display — PENDING
    // Jose's final confirmation at the review meeting. Coordinated with the VAT
    // clause in docs/BRAND_NOTES.md. Revert/adjust if Jose changes the wording.
    en: "Prices are shown in two currencies: the MXN price is exclusive of VAT; the USD price already includes 16% VAT. Any exchange-rate difference is settled at the invoicing-date FX.",
    zh: "本报价以两种币种显示：比索（MXN）价为不含税价；美金（USD）价已含 16% 增值税（VAT）。汇率差异按开票当日汇率结算。",
  },
  {
    en: "Any costs not caused by our company will be charged based on actual expenses.",
    zh: "非我方原因产生的任何费用，将按实际发生金额收取。",
  },
  {
    en: "The transport fee excludes cargo insurance. If insurance is required, it will be 0.25% of the insured value plus 16% VAT.",
    zh: "运费不含货物保险；如需投保，按保额的 0.25% 加收，并另加 16% 增值税。",
  },
  {
    en: "Any exchange rate differences will be settled based on the exchange rate on the invoicing date.",
    zh: "任何汇率差异均按开票当日汇率结算。",
  },
  {
    en: "This quotation is valid for 90 days.",
    zh: "本报价有效期为 90 天。",
  },
]);

const DEFAULT_QUOTE_HEADER = Object.freeze({
  operation: "IMPORT",
  department: "OCEAN",
  incoterm: "CIF",
  pol: "CHINA",
  pod: "MANZANILLO",
  commodity: "",
  cargoType: "FCL",
  delivery: "",
});

function isAtCostValue(value) {
  return String(value ?? "").trim().toUpperCase() === "AT COST";
}

function toNumber(value, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatMoney(value) {
  return Number(roundMoney(value)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// --- Fee-code controlled vocabulary (docs/reference/fee-codes.csv) -----------
let feeCodesCache = null;
function loadFeeCodes() {
  if (feeCodesCache) {
    return feeCodesCache;
  }
  const csvPath = path.join(__dirname, "../../docs/reference/fee-codes.csv");
  try {
    const raw = fs.readFileSync(csvPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length);
    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      const comma = line.indexOf(",");
      if (comma < 0) {
        continue;
      }
      const code = line.slice(0, comma).trim();
      const description = line.slice(comma + 1).trim();
      if (code) {
        rows.push({ code, description });
      }
    }
    feeCodesCache = rows;
  } catch (_error) {
    feeCodesCache = [];
  }
  return feeCodesCache;
}

// --- Quote number ------------------------------------------------------------
function generateQuoteNumber(settings = {}) {
  const prefix =
    typeof settings.quoteNumberPrefix === "string" ? settings.quoteNumberPrefix : "ELCMEX-SI-";
  const suffix =
    typeof settings.quoteNumberSuffix === "string" ? settings.quoteNumberSuffix : "E";
  const pad = Math.min(8, Math.max(1, Math.trunc(Number(settings.quoteNumberPad) || 3)));
  const nextSeq = Math.max(0, Math.trunc(Number(settings.lastQuoteSeq) || 0)) + 1;
  const number = `${prefix}${String(nextSeq).padStart(pad, "0")}${suffix}`;
  return { number, nextSeq };
}

// Seed a fresh set of editable line items (new ids) from the template rows.
function buildInitialLineItems() {
  return QUOTE_TEMPLATE_ROWS.map((row, index) => ({
    ...row,
    calcRef: row.calcRef ? { ...row.calcRef } : null,
    id: `li-${index + 1}`,
  }));
}

// --- Currency conversion (indicative only) -----------------------------------
function convertAmount(amount, from, to, pairs = []) {
  if (!from || !to || from === to) {
    return amount;
  }
  const direct = pairs.find((pair) => pair.base === from && pair.quote === to);
  if (direct && Number.isFinite(Number(direct.rate))) {
    return amount * Number(direct.rate);
  }
  const inverse = pairs.find((pair) => pair.base === to && pair.quote === from);
  if (inverse && Number(inverse.rate)) {
    return amount / Number(inverse.rate);
  }
  return null;
}

// Per-row total + subtotals by currency. AT COST rows never contribute.
function computeQuoteTotals(lineItems = [], options = {}) {
  const pairs = options.exchangeRates?.pairs || [];
  const subtotals = {};
  const rows = lineItems.map((item) => {
    const atCost = Boolean(item.isAtCost) || isAtCostValue(item.unitPrice);
    const unit = item.unit === null || item.unit === undefined ? null : toNumber(item.unit, 0);
    const unitPrice = atCost ? null : toNumber(item.unitPrice, 0);
    const total = atCost || unit === null ? null : roundMoney(unit * unitPrice);
    if (total !== null && item.currency) {
      subtotals[item.currency] = roundMoney((subtotals[item.currency] || 0) + total);
    }
    return {
      ...item,
      isAtCost: atCost,
      unit,
      unitPrice: atCost ? "AT COST" : unitPrice,
      total,
      totalLabel: total === null ? "AT COST" : formatMoney(total),
      unitPriceLabel: atCost ? "AT COST" : formatMoney(unitPrice),
    };
  });

  const subtotalList = Object.entries(subtotals).map(([currency, amount]) => ({
    currency,
    amount: roundMoney(amount),
    amountLabel: formatMoney(amount),
  }));

  let indicative = null;
  if (options.showIndicativeConversion && subtotalList.length) {
    const target = options.indicativeCurrency || "MXN";
    let sum = 0;
    let ok = true;
    for (const entry of subtotalList) {
      const converted = convertAmount(entry.amount, entry.currency, target, pairs);
      if (converted === null) {
        ok = false;
        break;
      }
      sum += converted;
    }
    if (ok) {
      indicative = {
        currency: target,
        amount: roundMoney(sum),
        amountLabel: formatMoney(sum),
        asOfDate: options.exchangeRates?.asOfDate || null,
      };
    }
  }

  // R4 dual-currency display (report layer). Additive: existing rows / subtotals
  // / indicative are unchanged. Convert every priced row to a single MXN base
  // (pretax), then present two prices with independent IVA toggles:
  //   MXN price = mxnBase x (1 + ivaMxn)        (default ivaMxn = 0,    sin IVA)
  //   USD price = mxnBase / fx(USD->MXN) x (1 + ivaUsd)  (default ivaUsd = 0.16, con IVA)
  // FX comes from the system rates (exchangeRates); when unavailable the USD
  // side degrades to null (rendered as "—") without blocking the MXN side.
  let dualTotals = null;
  if (options.dualCurrency) {
    const baseCurrency = options.baseCurrency || "MXN";
    const ivaMxn = Number.isFinite(Number(options.ivaMxn)) ? Number(options.ivaMxn) : 0;
    const ivaUsd = Number.isFinite(Number(options.ivaUsd)) ? Number(options.ivaUsd) : 0.16;

    let mxnBase = 0;
    let baseOk = true;
    for (const entry of subtotalList) {
      const converted = convertAmount(entry.amount, entry.currency, baseCurrency, pairs);
      if (converted === null) {
        baseOk = false;
        break;
      }
      mxnBase += converted;
    }
    mxnBase = roundMoney(mxnBase);

    const usdBase = baseOk ? convertAmount(mxnBase, baseCurrency, "USD", pairs) : null;
    const usdToMxn = pairs.find((p) => p.base === "USD" && p.quote === "MXN");
    dualTotals = {
      mxn: {
        base: mxnBase,
        iva: ivaMxn,
        shown: baseOk ? roundMoney(mxnBase * (1 + ivaMxn)) : null,
        shownLabel: baseOk ? formatMoney(mxnBase * (1 + ivaMxn)) : null,
      },
      usd: {
        iva: ivaUsd,
        shown: usdBase === null ? null : roundMoney(usdBase * (1 + ivaUsd)),
        shownLabel: usdBase === null ? null : formatMoney(usdBase * (1 + ivaUsd)),
      },
      fxRate: usdToMxn ? Number(usdToMxn.rate) : null,
      fxAsOf: options.exchangeRates?.asOfDate || null,
    };
  }

  return { rows, subtotals: subtotalList, indicative, dualTotals };
}

// --- Calculator pulls (D1) ---------------------------------------------------
// Calculators are injected by the caller (server.js) to keep this module free of
// require cycles. Fills calc-mapped rows in place; never throws on missing data.
function pullCalculatorValues({ shippingData, inputs = {}, lineItems = [], calculators = {}, t }) {
  const items = lineItems.map((item) => ({ ...item }));
  const setRow = (module, field, patch) => {
    const row = items.find(
      (item) => item.calcRef?.module === module && item.calcRef?.field === field
    );
    if (row) {
      Object.assign(row, patch);
    }
  };
  const quantity = Math.max(1, Math.trunc(toNumber(inputs.quantity, 1)) || 1);
  const containerKey = String(inputs.containerTypeKey || "").trim();
  const exchangeRates = shippingData?.exchangeRates;
  const tt = typeof t === "function" ? t : (key) => key;

  // #3 handover demurrage
  try {
    const handover = shippingData?.modules?.handover;
    const line =
      handover?.shippingLines?.find((entry) => entry.id === inputs.shippingLineId) ||
      handover?.shippingLines?.[0];
    if (handover && line && calculators.computeHandoverCalculator) {
      const groupKey =
        containerKey || handover.containerTypes?.[0]?.key || line.containerGroups?.[0]?.key || "";
      const result = calculators.computeHandoverCalculator(
        line,
        {
          shippingLineId: line.id,
          blCount: 1,
          demurrageDays: Math.max(0, Math.trunc(toNumber(inputs.demurrageDays, 0))),
          priceMode: "pretax",
          quoteCurrency: "USD",
          businessNature: "handover_only",
          taxOverrides: {},
          containerRows: [{ containerGroupKey: groupKey, quantity }],
        },
        {
          exchangeRates,
          settings: handover.settings,
          containerTypes: handover.containerTypes,
        },
        { t: tt }
      );
      const amount = result?.demurrage?.pretaxTotal;
      // Only fill when there is a real positive charge; otherwise keep the
      // template's AT COST default (e.g. demurrageDays=0 -> 0, not "0.00 USD").
      if (Number.isFinite(amount) && amount > 0) {
        setRow("handover", "demurrage", {
          unitPrice: roundMoney(amount),
          unit: 1,
          currency: result.quoteCurrency || "USD",
          isAtCost: false,
          source: "calc",
        });
      }
    }
  } catch (_error) {
    /* leave default on any calculator error */
  }

  // #4 customs terminalFixed + #5 customs terminalStorage
  try {
    const customs = shippingData?.modules?.customs;
    if (customs && calculators.computeCustomsCalculator && customs.ports?.length) {
      const line =
        customs.shippingLines?.find((entry) => entry.id === inputs.shippingLineId) ||
        customs.shippingLines?.[0];
      const port =
        customs.ports.find((entry) => entry.id === inputs.portId) || customs.ports[0];
      const terminal =
        port?.terminals?.find((entry) => entry.id === inputs.terminalId) ||
        port?.terminals?.[0];
      const groupKey = containerKey || customs.containerTypes?.[0]?.key || "";
      const result = calculators.computeCustomsCalculator(
        customs,
        {
          shippingLineId: line?.id || "",
          portId: port?.id || "",
          terminalId: terminal?.id || "",
          yardId: "",
          storageDays: Math.max(0, Math.trunc(toNumber(inputs.storageDays, 0))),
          priceMode: "pretax",
          quoteCurrency: "MXN",
          businessNature: "customs_only",
          taxOverrides: {},
          containerRows: [{ containerGroupKey: groupKey, quantity }],
        },
        { exchangeRates },
        { t: tt }
      );
      if (Number.isFinite(result?.terminalFixed?.pretaxTotal) && result.terminalFixed.pretaxTotal > 0) {
        setRow("customs", "terminalFixed", {
          unitPrice: roundMoney(result.terminalFixed.pretaxTotal),
          unit: 1,
          currency: result.quoteCurrency || "MXN",
          isAtCost: false,
          source: "calc",
        });
      }
      if (Number.isFinite(result?.terminalStorage?.pretaxTotal) && result.terminalStorage.pretaxTotal > 0) {
        setRow("customs", "terminalStorage", {
          unitPrice: roundMoney(result.terminalStorage.pretaxTotal),
          unit: 1,
          currency: result.quoteCurrency || "MXN",
          isAtCost: false,
          source: "calc",
        });
      }
    }
  } catch (_error) {
    /* leave defaults */
  }

  // #7 inland sencillo + #8 inland full
  try {
    const inland = shippingData?.modules?.inland;
    const destinationId = String(inputs.destinationId || "").trim();
    if (inland && destinationId && calculators.computeInlandCalculator) {
      for (const serviceType of ["sencillo", "full"]) {
        const result = calculators.computeInlandCalculator(
          inland,
          {
            destinationId,
            serviceType,
            quantity,
            priceMode: "pretax",
            taxRateOverride: "default",
            precisePointId: "",
          },
          { t: tt }
        );
        if (result && !result.noRate && Number.isFinite(result.maxRate) && result.maxRate > 0) {
          setRow("inland", serviceType, {
            unitPrice: roundMoney(result.maxRate),
            unit: quantity,
            currency: result.quoteCurrency || "MXN",
            isAtCost: false,
            source: "calc",
          });
        }
      }
    }
  } catch (_error) {
    /* leave defaults */
  }

  return items;
}

// Group computed rows for rendering, in the fixed category order.
function groupRowsForRender(rows = []) {
  return QUOTE_GROUP_ORDER.map((category) => ({
    category,
    items: rows.filter((row) => row.category === category),
  })).filter((group) => group.items.length);
}

// Resolve the cached driving route (origin -> destination) for a quote so the
// document can show distance / duration / via-cities. Pure data lookup over the
// inland module — no network. Returns null when the destination or its cached
// route is unknown (the document then renders a "—" placeholder, never crashes).
function resolveQuoteRoute(inlandModule = {}, destinationId, originId) {
  const destId = String(destinationId || "").trim();
  if (!destId) {
    return null;
  }
  const origins = inlandModule.origins || [];
  const origin = (originId && origins.find((o) => o.id === originId)) || origins[0] || null;
  const dest = (inlandModule.destinations || []).find((d) => d.id === destId) || null;
  const route = (inlandModule.routeCache || []).find(
    (rc) =>
      rc.destinationId === destId &&
      rc.targetType === "destination" &&
      (!origin || rc.originId === origin.id)
  );
  if (!route) {
    return null;
  }
  return {
    originName: origin ? origin.name : "",
    destName: dest ? dest.name : destId,
    distanceKm: route.distanceKm ?? null,
    durationMin: route.durationMin ?? null,
    viaCities: Array.isArray(route.viaCities) ? route.viaCities : [],
    hasFerry: Boolean(route.hasFerry),
    stale: Boolean(route.stale),
  };
}

module.exports = {
  QUOTE_TEMPLATE_VERSION,
  QUOTE_GROUP_ORDER,
  QUOTE_TEMPLATE_ROWS,
  QUOTE_NOTES,
  DEFAULT_QUOTE_HEADER,
  isAtCostValue,
  toNumber,
  roundMoney,
  formatMoney,
  loadFeeCodes,
  generateQuoteNumber,
  buildInitialLineItems,
  computeQuoteTotals,
  pullCalculatorValues,
  groupRowsForRender,
  resolveQuoteRoute,
};
