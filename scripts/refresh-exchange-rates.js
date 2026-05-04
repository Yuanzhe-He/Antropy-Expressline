const {
  refreshExchangeRatesNow,
} = require("../src/lib/exchange-rate-scheduler");
const { closeDatabase } = require("../src/lib/db");

async function main() {
  const result = await refreshExchangeRatesNow({ force: true });
  const usdMxn = result.exchangeRates.pairs.find(
    (pair) => pair.base === "USD" && pair.quote === "MXN"
  );

  console.log(
    `fx-refresh-ok provider=${result.exchangeRates.provider} asOf=${result.exchangeRates.asOfDate} USD/MXN=${usdMxn?.rate}`
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
