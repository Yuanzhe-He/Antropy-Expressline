const { refreshExchangeRatesIfStale } = require("./exchange-rates");
const { getShippingData, saveExchangeRates } = require("./store");

const DEFAULT_FX_REFRESH_TIME_ZONE = "America/Mexico_City";
const DEFAULT_FX_REFRESH_HOUR = 0;
const DEFAULT_FX_REFRESH_MINUTE = 0;

let activeTimer = null;

function parseBoundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function normalizeRefreshOptions(options = {}) {
  return {
    timeZone:
      options.timeZone ||
      process.env.FX_REFRESH_TIME_ZONE ||
      DEFAULT_FX_REFRESH_TIME_ZONE,
    hour: parseBoundedInteger(
      options.hour ?? process.env.FX_REFRESH_HOUR,
      DEFAULT_FX_REFRESH_HOUR,
      0,
      23
    ),
    minute: parseBoundedInteger(
      options.minute ?? process.env.FX_REFRESH_MINUTE,
      DEFAULT_FX_REFRESH_MINUTE,
      0,
      59
    ),
  };
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }

  return parts;
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - date.getTime();
}

function zonedTimeToUtc({ year, month, day, hour, minute, second }, timeZone) {
  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  for (let index = 0; index < 3; index += 1) {
    const offsetMs = getTimeZoneOffsetMs(utc, timeZone);
    utc = new Date(
      Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs
    );
  }

  return utc;
}

function getNextRefreshAt(
  now = new Date(),
  options = {}
) {
  const { timeZone, hour, minute } = normalizeRefreshOptions(options);
  const current = getZonedParts(now, timeZone);
  const todayTarget = zonedTimeToUtc(
    {
      year: current.year,
      month: current.month,
      day: current.day,
      hour,
      minute,
      second: 0,
    },
    timeZone
  );

  if (todayTarget.getTime() > now.getTime()) {
    return todayTarget;
  }

  const nextLocalDate = new Date(
    Date.UTC(current.year, current.month - 1, current.day + 1)
  );
  return zonedTimeToUtc(
    {
      year: nextLocalDate.getUTCFullYear(),
      month: nextLocalDate.getUTCMonth() + 1,
      day: nextLocalDate.getUTCDate(),
      hour,
      minute,
      second: 0,
    },
    timeZone
  );
}

async function refreshExchangeRatesNow(options = {}) {
  const shippingData = await getShippingData();
  const refreshed = await refreshExchangeRatesIfStale(shippingData, {
    force: Boolean(options.force),
  });

  if (refreshed.changed) {
    await saveExchangeRates(refreshed.data);
  }

  return {
    changed: refreshed.changed,
    exchangeRates: refreshed.data.exchangeRates,
  };
}

function startExchangeRateScheduler(options = {}) {
  if (activeTimer || process.env.SKIP_FX_REFRESH === "1") {
    return null;
  }

  const { timeZone, hour, minute } = normalizeRefreshOptions(options);

  function scheduleNext() {
    let nextRefreshAt;
    try {
      nextRefreshAt = getNextRefreshAt(new Date(), { timeZone, hour, minute });
    } catch (error) {
      console.error(`Exchange rate scheduler disabled: ${error.message}`);
      activeTimer = null;
      return;
    }
    const delayMs = Math.max(1000, nextRefreshAt.getTime() - Date.now());

    activeTimer = setTimeout(async () => {
      try {
        const result = await refreshExchangeRatesNow({ force: true });
        console.log(
          `Exchange rates refreshed provider=${result.exchangeRates.provider} asOf=${result.exchangeRates.asOfDate}`
        );
      } catch (error) {
        console.error(`Exchange rate scheduled refresh failed: ${error.message}`);
      } finally {
        activeTimer = null;
        scheduleNext();
      }
    }, delayMs);

    if (typeof activeTimer.unref === "function") {
      activeTimer.unref();
    }
  }

  scheduleNext();
  return {
    stop() {
      if (activeTimer) {
        clearTimeout(activeTimer);
        activeTimer = null;
      }
    },
  };
}

module.exports = {
  getNextRefreshAt,
  refreshExchangeRatesNow,
  startExchangeRateScheduler,
};
