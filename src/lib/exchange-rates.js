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

function needsExchangeRateRefresh(exchangeRates) {
  if (!exchangeRates?.pairs?.length) {
    return true;
  }
  if (!exchangeRates.lastCheckedAt) {
    return true;
  }
  return exchangeRates.lastCheckedAt.slice(0, 10) !== todayIsoDate();
}

async function fetchLatestUsdMxnRates() {
  const response = await fetch(
    "https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN"
  );

  if (!response.ok) {
    throw new Error(`Exchange rate request failed with ${response.status}`);
  }

  const payload = await response.json();
  const usdToMxn = Number(payload?.rates?.MXN);
  if (!Number.isFinite(usdToMxn) || usdToMxn <= 0) {
    throw new Error("Exchange rate payload is missing USD/MXN");
  }

  return {
    provider: "Frankfurter",
    docsUrl: "https://frankfurter.dev/v1/",
    asOfDate: payload.date || null,
    lastCheckedAt: new Date().toISOString(),
    lastError: null,
    defaultQuoteCurrency: DEFAULT_QUOTE_CURRENCY,
    pairs: [
      { base: "USD", quote: "MXN", rate: roundCurrency(usdToMxn) },
      { base: "MXN", quote: "USD", rate: roundCurrency(1 / usdToMxn) },
    ],
  };
}

async function refreshExchangeRatesIfStale(shippingData, options = {}) {
  if (!options.force && !needsExchangeRateRefresh(shippingData.exchangeRates)) {
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
  findExchangeRate,
  refreshExchangeRatesIfStale,
};
