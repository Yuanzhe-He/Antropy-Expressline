const {
  DEFAULT_QUOTE_CURRENCY,
  normalizeCurrencyCode,
} = require("./options");

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 1000000) / 1000000;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function formatIsoDateFromUtcString(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function needsExchangeRateRefresh(exchangeRates) {
  if (!exchangeRates?.pairs?.length) {
    return true;
  }
  if (!exchangeRates.lastCheckedAt) {
    return true;
  }
  return exchangeRates.lastCheckedAt.slice(0, 10) !== todayIsoDate();
}

// Throttle: minimum spacing between actual FX fetches+writes, even when forced.
// Frankfurter publishes daily reference rates, so re-fetching within minutes is
// pointless — but a high-frequency caller hitting the forced-refresh path (the
// prod "write storm": ~1 write/2s, ~28k/day) would otherwise re-fetch+write on
// every request. With this gate a spammed forced refresh writes at most once per
// interval; the daily scheduler and a genuine manual refresh still work.
const MIN_REFRESH_INTERVAL_MS = (() => {
  const parsed = Number(process.env.FX_MIN_REFRESH_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15 * 60 * 1000;
})();

function checkedWithinThrottle(exchangeRates) {
  if (!exchangeRates?.lastCheckedAt) {
    return false;
  }
  const age = Date.now() - new Date(exchangeRates.lastCheckedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < MIN_REFRESH_INTERVAL_MS;
}

function buildExchangeRatePayload({ provider, docsUrl, asOfDate, usdToMxn }) {
  return {
    provider,
    docsUrl,
    asOfDate,
    lastCheckedAt: new Date().toISOString(),
    lastError: null,
    defaultQuoteCurrency: DEFAULT_QUOTE_CURRENCY,
    pairs: [
      { base: "USD", quote: "MXN", rate: roundCurrency(usdToMxn) },
      { base: "MXN", quote: "USD", rate: roundCurrency(1 / usdToMxn) },
    ],
  };
}

async function fetchFrankfurterUsdMxnRates() {
  const response = await fetch(
    "https://api.frankfurter.dev/v2/rates?base=USD&quotes=MXN"
  );

  if (!response.ok) {
    throw new Error(`Frankfurter request failed with ${response.status}`);
  }

  const payload = await response.json();
  const row = Array.isArray(payload) ? payload[0] : null;
  const usdToMxn = Number(row?.rate);
  if (!Number.isFinite(usdToMxn) || usdToMxn <= 0) {
    throw new Error("Frankfurter payload is missing USD/MXN");
  }

  return buildExchangeRatePayload({
    provider: "Frankfurter",
    docsUrl: "https://frankfurter.dev/",
    asOfDate: row.date || null,
    usdToMxn,
  });
}

async function fetchExchangeRateApiUsdMxnRates() {
  const response = await fetch("https://open.er-api.com/v6/latest/USD");

  if (!response.ok) {
    throw new Error(`ExchangeRate-API request failed with ${response.status}`);
  }

  const payload = await response.json();
  const usdToMxn = Number(payload?.rates?.MXN);
  if (
    payload?.result !== "success" ||
    !Number.isFinite(usdToMxn) ||
    usdToMxn <= 0
  ) {
    throw new Error("ExchangeRate-API payload is missing USD/MXN");
  }

  return buildExchangeRatePayload({
    provider: "ExchangeRate-API Open Access",
    docsUrl: payload.documentation || "https://www.exchangerate-api.com/docs/free",
    asOfDate: formatIsoDateFromUtcString(payload.time_last_update_utc),
    usdToMxn,
  });
}

async function fetchLatestUsdMxnRates() {
  const errors = [];

  for (const fetcher of [
    fetchFrankfurterUsdMxnRates,
    fetchExchangeRateApiUsdMxnRates,
  ]) {
    try {
      return await fetcher();
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(`All exchange rate providers failed: ${errors.join("; ")}`);
}

async function refreshExchangeRatesIfStale(shippingData, options = {}) {
  if (!options.force && !needsExchangeRateRefresh(shippingData.exchangeRates)) {
    return { changed: false, data: shippingData };
  }

  // Even a forced refresh is throttled: if we already checked within the window
  // (success OR failure both stamp lastCheckedAt), skip the fetch+write. This is
  // what caps the prod write storm — a forced-refresh caller hammering every 2s
  // now writes at most once per MIN_REFRESH_INTERVAL_MS instead of every request.
  if (checkedWithinThrottle(shippingData.exchangeRates)) {
    return { changed: false, data: shippingData };
  }

  try {
    const latest = await fetchLatestUsdMxnRates();
    return {
      changed: true,
      data: {
        ...shippingData,
        exchangeRates: latest,
      },
    };
  } catch (error) {
    return {
      changed: true,
      data: {
        ...shippingData,
        exchangeRates: {
          ...(shippingData.exchangeRates || {}),
          lastCheckedAt: new Date().toISOString(),
          lastError: error.message,
        },
      },
    };
  }
}

function findExchangeRate(exchangeRates, fromCurrency, toCurrency) {
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  if (from === to) {
    return 1;
  }

  const direct = (exchangeRates?.pairs || []).find(
    (pair) => pair.base === from && pair.quote === to
  );
  if (direct) {
    return Number(direct.rate);
  }

  const reverse = (exchangeRates?.pairs || []).find(
    (pair) => pair.base === to && pair.quote === from
  );
  if (reverse && Number(reverse.rate) > 0) {
    return roundCurrency(1 / Number(reverse.rate));
  }

  throw new Error(`Missing exchange rate for ${from}/${to}`);
}

function convertAmount(amount, fromCurrency, toCurrency, exchangeRates) {
  const rate = findExchangeRate(exchangeRates, fromCurrency, toCurrency);
  return {
    exchangeRate: rate,
    convertedAmount: roundCurrency(Number(amount) * rate),
  };
}

module.exports = {
  convertAmount,
  fetchLatestUsdMxnRates,
  findExchangeRate,
  needsExchangeRateRefresh,
  refreshExchangeRatesIfStale,
};
