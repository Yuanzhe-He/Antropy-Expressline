const {
  getCategoryLabel,
  getDemurrageCutoffLabel,
  getTaxRateLabel,
  normalizeCurrencyCode,
  normalizePriceMode,
  normalizeTaxRate,
} = require("./options");
const { convertAmount } = require("./exchange-rates");
const { normalizeVehicleType, getVehiclePrice } = require("./inland-vehicles");

// 7-tier vehicle -> i18n label key (reuses the S2 vehicle i18n; sencillo/full
// keep their existing service* keys). Without this, the explanation text would
// show every non-full tier as "Sencillo".
const VEHICLE_LABEL_KEYS = {
  light_1_5t: "inland.vehicleLight15t",
  light_3_5t: "inland.vehicleLight35t",
  short_8t: "inland.vehicleShort8t",
  sencillo: "inland.serviceSencillo",
  full: "inland.serviceFull",
  lowboy: "inland.vehicleLowboy",
  box_53: "inland.vehicleBox53",
};
function vehicleLabel(t, type) {
  return t(VEHICLE_LABEL_KEYS[type] || "inland.serviceSencillo");
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatAmount(value) {
  return roundMoney(value).toFixed(2);
}

function formatFxRate(value) {
  return Number(value).toFixed(6);
}

function formatTierLabel(startDay, endDay) {
  if (startDay === null || startDay === undefined) {
    return "未设置";
  }
  if (endDay === null || endDay === undefined) {
    return `>${startDay - 1}`;
  }
  if (startDay === endDay) {
    return `${startDay}`;
  }
  return `${startDay}-${endDay}`;
}

function formatRuleDisplayLabel(rule) {
  if (rule?.label) {
    return rule.label;
  }
  return formatTierLabel(rule?.startDay, rule?.endDay);
}

function buildTypedRows(typeList = [], rowsInput = [], t, unknownLabelKey) {
  const rows = rowsInput.length
    ? rowsInput
    : [
        {
          containerGroupKey: typeList?.[0]?.key || "",
          quantity: 0,
        },
      ];

  return rows
    .map((row, index) => {
      const type =
        typeList.find((entry) => entry.key === row.containerGroupKey) || null;

      return {
        id: `row-${index + 1}`,
        containerGroupKey: type?.key || row.containerGroupKey || "",
        label: type?.label || row.containerGroupKey || t(unknownLabelKey),
        rateGroupKeys: Array.isArray(type?.rateGroupKeys)
          ? type.rateGroupKeys
          : [],
        quantity: parseNumber(row.quantity, 0),
      };
    })
    .filter((row) => row.containerGroupKey);
}

function resolveRateGroupKey(row, rateMap = {}) {
  const candidates = [
    ...(Array.isArray(row.rateGroupKeys) ? row.rateGroupKeys : []),
    row.containerGroupKey,
  ].filter(Boolean);

  return candidates.find((key) => rateMap?.[key]) || Object.keys(rateMap || {})[0] || "";
}

function resolveDemurrageRules(row, shippingLine) {
  const assignedRuleSetId =
    shippingLine.demurrage?.assignmentsByContainerType?.[row.containerGroupKey];
  const assignedRuleSet = (shippingLine.demurrage?.ruleSets || []).find(
    (set) => set.id === assignedRuleSetId
  );
  if (assignedRuleSet?.rules?.length) {
    return assignedRuleSet.rules;
  }

  const rateGroupKey = resolveRateGroupKey(row, shippingLine.demurrage?.rulesByGroup);
  return shippingLine.demurrage?.rulesByGroup?.[rateGroupKey] || [];
}

function buildRatePart({
  description,
  rateConfig,
  multipliers,
  quoteCurrency,
  exchangeRates,
}) {
  const quantityMultiplier = multipliers.reduce(
    (product, multiplier) => product * multiplier.value,
    1
  );
  const sourcePretax = roundMoney(rateConfig.rate * quantityMultiplier);
  const { exchangeRate, convertedAmount } = convertAmount(
    sourcePretax,
    rateConfig.currency,
    quoteCurrency,
    exchangeRates
  );
  const pretaxAmount = roundMoney(convertedAmount);
  const multiplierText = multipliers
    .map((multiplier) => `${multiplier.value} ${multiplier.label}`)
    .join(" × ");
  const sourceFormula = `${formatAmount(rateConfig.rate)} ${rateConfig.currency} × ${multiplierText}`;

  return {
    description,
    currency: rateConfig.currency,
    unitRate: rateConfig.rate,
    multipliers,
    sourcePretax,
    quoteCurrency,
    exchangeRate,
    pretaxAmount,
    formulaSegment:
      rateConfig.currency === quoteCurrency
        ? sourceFormula
        : `(${sourceFormula}) × ${formatFxRate(exchangeRate)} ${quoteCurrency}/${rateConfig.currency}`,
    summaryLabel: `${description}: ${sourceFormula}`,
  };
}

function buildItemFormula(parts, pretaxAmount, afterTaxAmount, taxRate, quoteCurrency, priceMode) {
  if (!parts.length) {
    return `0.00 ${quoteCurrency}`;
  }

  const pretaxExpression = parts.map((part) => part.formulaSegment).join(" + ");
  if (priceMode === "aftertax") {
    return `(${pretaxExpression}) × ${formatAmount(
      1 + taxRate
    )} = ${formatAmount(afterTaxAmount)} ${quoteCurrency}`;
  }
  return `${pretaxExpression} = ${formatAmount(pretaxAmount)} ${quoteCurrency}`;
}

function buildSourceAmountLabel(parts, taxRate, priceMode, fallbackCurrency) {
  if (!parts.length) {
    return `0.00 ${fallbackCurrency}`;
  }

  const taxMultiplier = priceMode === "aftertax" ? 1 + taxRate : 1;
  const totalsByCurrency = new Map();
  for (const part of parts) {
    const currentTotal = totalsByCurrency.get(part.currency) || 0;
    totalsByCurrency.set(
      part.currency,
      roundMoney(currentTotal + part.sourcePretax * taxMultiplier)
    );
  }

  return [...totalsByCurrency.entries()]
    .map(([currency, amount]) => `${formatAmount(amount)} ${currency}`)
    .join(" + ");
}

function resolveTaxRate(defaultTaxRate, taxOverrides = {}, overrideKey) {
  const overrideValue = taxOverrides?.[overrideKey];
  if (
    overrideValue === undefined ||
    overrideValue === null ||
    overrideValue === "" ||
    overrideValue === "default"
  ) {
    return normalizeTaxRate(defaultTaxRate, 0);
  }
  return normalizeTaxRate(overrideValue, normalizeTaxRate(defaultTaxRate, 0));
}

function buildDisplayItem({
  itemId,
  categoryKey,
  concept,
  note,
  parts,
  taxRate,
  quoteCurrency,
  priceMode,
  explanation,
}) {
  const pretaxAmount = roundMoney(
    parts.reduce((sum, part) => sum + part.pretaxAmount, 0)
  );
  const afterTaxAmount = roundMoney(pretaxAmount * (1 + taxRate));
  const displayAmount = priceMode === "aftertax" ? afterTaxAmount : pretaxAmount;
  const sourceDisplayAmountLabel = buildSourceAmountLabel(
    parts,
    taxRate,
    priceMode,
    quoteCurrency
  );
  const convertedDisplayAmountLabel = `${formatAmount(displayAmount)} ${quoteCurrency}`;

  return {
    itemId,
    categoryKey,
    concept,
    note,
    taxRate,
    taxRateLabel: getTaxRateLabel(taxRate),
    quoteCurrency,
    parts,
    pretaxAmount,
    afterTaxAmount,
    displayAmount,
    sourceDisplayAmountLabel,
    convertedDisplayAmountLabel,
    formula: buildItemFormula(
      parts,
      pretaxAmount,
      afterTaxAmount,
      taxRate,
      quoteCurrency,
      priceMode
    ),
    explanation,
  };
}

function buildZeroItem({
  itemId,
  categoryKey,
  concept,
  note,
  taxRate,
  quoteCurrency,
  explanation,
}) {
  return {
    itemId,
    categoryKey,
    concept,
    note,
    taxRate,
    taxRateLabel: getTaxRateLabel(taxRate),
    quoteCurrency,
    parts: [],
    pretaxAmount: 0,
    afterTaxAmount: 0,
    displayAmount: 0,
    sourceDisplayAmountLabel: `0.00 ${quoteCurrency}`,
    convertedDisplayAmountLabel: `0.00 ${quoteCurrency}`,
    formula: `0.00 ${quoteCurrency}`,
    explanation,
  };
}

function finalizeCategory({ key, title, items, quoteCurrency, priceMode, t }) {
  const pretaxTotal = roundMoney(
    items.reduce((sum, item) => sum + item.pretaxAmount, 0)
  );
  const afterTaxTotal = roundMoney(
    items.reduce((sum, item) => sum + item.afterTaxAmount, 0)
  );
  const displayTotal = priceMode === "aftertax" ? afterTaxTotal : pretaxTotal;

  return {
    key,
    title: title || getCategoryLabel(key, t),
    items,
    quoteCurrency,
    pretaxTotal,
    afterTaxTotal,
    displayTotal,
  };
}

function getProgressiveRuleWindow(totalDays, startDay, endDay, coveredUntil) {
  if (startDay === null || startDay === undefined) {
    return null;
  }
  const effectiveStart = Math.max(startDay, coveredUntil + 1, 1);
  const effectiveEnd =
    endDay === null || endDay === undefined ? totalDays : Math.min(endDay, totalDays);

  if (effectiveEnd < effectiveStart) {
    return null;
  }

  return {
    startDay: effectiveStart,
    endDay: effectiveEnd,
    dayCount: effectiveEnd - effectiveStart + 1,
  };
}

function computeCategoryTotals(categories, priceMode) {
  const pretaxTotal = roundMoney(
    categories.reduce((sum, category) => sum + category.pretaxTotal, 0)
  );
  const afterTaxTotal = roundMoney(
    categories.reduce((sum, category) => sum + category.afterTaxTotal, 0)
  );
  return {
    pretaxTotal,
    afterTaxTotal,
    total: priceMode === "aftertax" ? afterTaxTotal : pretaxTotal,
  };
}

function computeHandoverCalculator(shippingLine, formData, referenceData, options = {}) {
  const t = options.t || ((key) => key);
  const blCount = parseNumber(formData.blCount, 0);
  const demurrageDays = parseNumber(formData.demurrageDays, 0);
  const containerTypes = referenceData?.containerTypes?.length
    ? referenceData.containerTypes
    : shippingLine.containerGroups || [];
  const containerRows = buildTypedRows(
    containerTypes,
    formData.containerRows || [],
    t,
    "calculator.unknownContainer"
  ).filter((row) => row.quantity > 0);
  const priceMode = normalizePriceMode(formData.priceMode);
  const quoteCurrency = normalizeCurrencyCode(
    formData.quoteCurrency,
    referenceData?.settings?.defaultQuoteCurrency
  );
  const exchangeRates = referenceData.exchangeRates;
  const taxOverrides = formData.taxOverrides || {};
  const activeGuarantee = Boolean(
    shippingLine.guarantee?.benefitEnabled &&
      (!shippingLine.guarantee?.benefitExpiresAt ||
        new Date(shippingLine.guarantee.benefitExpiresAt) >= new Date())
  );

  const localChargeItems = [];
  for (const charge of shippingLine.localCharges || []) {
    const parts = [];

    if (charge.blRate && blCount > 0) {
      parts.push(
        buildRatePart({
          description: t("calculator.partBl"),
          rateConfig: charge.blRate,
          multipliers: [{ value: blCount, label: t("calculator.partBl") }],
          quoteCurrency,
          exchangeRates,
        })
      );
    }

    for (const row of containerRows) {
      const rateGroupKey = resolveRateGroupKey(row, charge.groupRates);
      const rateConfig = charge.groupRates?.[rateGroupKey];
      if (!rateConfig) {
        continue;
      }
      parts.push(
        buildRatePart({
          description: row.label,
          rateConfig,
          multipliers: [
            {
              value: row.quantity,
              label: t("calculator.partContainer", { label: row.label }),
            },
          ],
          quoteCurrency,
          exchangeRates,
        })
      );
    }

    if (!parts.length) {
      continue;
    }

    localChargeItems.push(
      buildDisplayItem({
        itemId: `handover:charge:${charge.id}`,
        categoryKey: "localCharges",
        concept: charge.concept,
        note: charge.note,
        parts,
        taxRate: resolveTaxRate(
          charge.taxRate,
          taxOverrides,
          `handover:charge:${charge.id}`
        ),
        quoteCurrency,
        priceMode,
        explanation: t("calculator.itemExplanationLocal", {
          taxRate: getTaxRateLabel(
            resolveTaxRate(charge.taxRate, taxOverrides, `handover:charge:${charge.id}`)
          ),
        }),
      })
    );
  }

  const guaranteeItems = [];
  if (activeGuarantee) {
    guaranteeItems.push(
      buildZeroItem({
        itemId: "handover:guarantee",
        categoryKey: "guarantee",
        concept: t("calculator.guaranteeWaived"),
        note: shippingLine.guarantee?.benefitExpiresAt
          ? `${t("admin.benefitExpiresAt")} ${shippingLine.guarantee.benefitExpiresAt}`
          : t("calculator.activeBenefit"),
        taxRate: resolveTaxRate(
          shippingLine.guarantee?.taxRate || 0,
          taxOverrides,
          "handover:guarantee"
        ),
        quoteCurrency,
        explanation: t("calculator.itemExplanationGuaranteeFree"),
      })
    );
  } else if (containerRows.length) {
    const parts = [];
    for (const row of containerRows) {
      const rateGroupKey = resolveRateGroupKey(row, shippingLine.guarantee?.ratesByGroup);
      const rateConfig = shippingLine.guarantee?.ratesByGroup?.[rateGroupKey];
      if (!rateConfig) {
        continue;
      }
      parts.push(
        buildRatePart({
          description: row.label,
          rateConfig,
          multipliers: [
            {
              value: row.quantity,
              label: t("calculator.partContainer", { label: row.label }),
            },
          ],
          quoteCurrency,
          exchangeRates,
        })
      );
    }

    if (parts.length) {
      const taxRate = resolveTaxRate(
        shippingLine.guarantee?.taxRate || 0,
        taxOverrides,
        "handover:guarantee"
      );
      guaranteeItems.push(
        buildDisplayItem({
          itemId: "handover:guarantee",
          categoryKey: "guarantee",
          concept: t("calculator.guaranteeName"),
          note: shippingLine.guarantee?.benefitNote,
          parts,
          taxRate,
          quoteCurrency,
          priceMode,
          explanation: t("calculator.itemExplanationGuaranteeCharged", {
            taxRate: getTaxRateLabel(taxRate),
          }),
        })
      );
    }
  }

  const demurrageItems = [];
  const matchedTierLabels = [];

  for (const row of containerRows) {
    const rules = resolveDemurrageRules(row, shippingLine);
    let coveredUntil = 0;
    for (const rule of rules) {
      const window = getProgressiveRuleWindow(
        demurrageDays,
        rule.startDay,
        rule.endDay,
        coveredUntil
      );

      if (!window || window.dayCount <= 0) {
        continue;
      }
      coveredUntil = window.endDay;

      const ruleLabel = formatRuleDisplayLabel(rule);
      const ruleTaxRate = resolveTaxRate(
        rule.taxRate || 0,
        taxOverrides,
        "handover:demurrage"
      );
      matchedTierLabels.push(`${row.label} ${ruleLabel}`);
      demurrageItems.push(
        buildDisplayItem({
          itemId: `handover:demurrage:${rule.id}`,
          categoryKey: "demurrage",
          concept: `Demoras ${row.label} ${ruleLabel}`,
          note: rule.note,
          parts: [
            buildRatePart({
              description: t("calculator.partDemurrageWindow", {
                label: row.label,
                days: window.dayCount,
              }),
              rateConfig: rule.rateConfig,
              multipliers: [
                { value: window.dayCount, label: t("calculator.partDays") },
                {
                  value: row.quantity,
                  label: t("calculator.partContainer", { label: row.label }),
                },
              ],
              quoteCurrency,
              exchangeRates,
            }),
          ],
          taxRate: ruleTaxRate,
          quoteCurrency,
          priceMode,
          explanation: rule.freeRule
            ? t("calculator.itemExplanationDemurrageFree", {
                container: row.label,
                ruleLabel,
              })
            : t("calculator.itemExplanationDemurrageCharged", {
                container: row.label,
                ruleLabel,
                taxRate: getTaxRateLabel(ruleTaxRate),
              }),
        })
      );
    }
  }

  const localCharges = finalizeCategory({
    key: "localCharges",
    items: localChargeItems,
    quoteCurrency,
    priceMode,
    t,
  });
  const guarantee = finalizeCategory({
    key: "guarantee",
    items: guaranteeItems,
    quoteCurrency,
    priceMode,
    t,
  });
  const demurrage = finalizeCategory({
    key: "demurrage",
    items: demurrageItems,
    quoteCurrency,
    priceMode,
    t,
  });

  const totals = computeCategoryTotals([localCharges, guarantee, demurrage], priceMode);

  const totalFormula =
    priceMode === "aftertax"
      ? t("calculator.totalFormulaAftertax", {
          local: formatAmount(localCharges.pretaxTotal),
          guarantee: formatAmount(guarantee.pretaxTotal),
          demurrage: formatAmount(demurrage.pretaxTotal),
          total: formatAmount(totals.total),
          currency: quoteCurrency,
        })
      : t("calculator.totalFormulaPretax", {
          local: formatAmount(localCharges.pretaxTotal),
          guarantee: formatAmount(guarantee.pretaxTotal),
          demurrage: formatAmount(demurrage.pretaxTotal),
          total: formatAmount(totals.total),
          currency: quoteCurrency,
        });

  return {
    businessNature: formData.businessNature,
    blCount,
    demurrageDays,
    containerRows,
    priceMode,
    quoteCurrency,
    activeGuarantee,
    matchedTierLabels,
    localCharges,
    guarantee,
    demurrage,
    pretaxTotal: totals.pretaxTotal,
    afterTaxTotal: totals.afterTaxTotal,
    total: totals.total,
    totalFormula,
    totalExplanation: t("calculator.totalExplanation", {
      currency: quoteCurrency,
      date: referenceData.exchangeRates?.asOfDate || t("common.notConfigured"),
      mode: priceMode === "aftertax" ? t("priceMode.aftertax") : t("priceMode.pretax"),
    }),
    invoiceToConsigneeOnly: shippingLine.invoiceToConsigneeOnly,
    invoiceNote: shippingLine.invoiceNote || null,
    demurrageCutoffHandledBy: shippingLine.demurrageCutoffHandledBy,
    demurrageCutoffHandledByLabel: getDemurrageCutoffLabel(
      shippingLine.demurrageCutoffHandledBy,
      t
    ),
    exchangeRates: referenceData.exchangeRates,
  };
}

function buildCustomsItem({
  itemId,
  concept,
  note,
  parts,
  taxRate,
  quoteCurrency,
  priceMode,
  explanation,
  categoryKey,
}) {
  return buildDisplayItem({
    itemId,
    categoryKey,
    concept,
    note,
    parts,
    taxRate,
    quoteCurrency,
    priceMode,
    explanation,
  });
}

function resolveTerminalStorageRuleSet(terminal, shippingLineId, containerTypeKey) {
  if (
    shippingLineId &&
    terminal?.storageUnassignedLineContainers?.includes(
      `${shippingLineId}::${containerTypeKey}`
    )
  ) {
    return null;
  }

  const assignedRuleSetId = Array.isArray(
    terminal?.storageAssignmentsByLineContainer?.[shippingLineId]?.[
      containerTypeKey
    ]
  )
    ? terminal.storageAssignmentsByLineContainer[shippingLineId][containerTypeKey][0]
    : terminal?.storageAssignmentsByLineContainer?.[shippingLineId]?.[
        containerTypeKey
      ] || terminal?.storageAssignmentsByContainerType?.[containerTypeKey];
  const ruleSet = (terminal?.storageRuleSets || []).find(
    (entry) => entry.id === assignedRuleSetId
  );

  if (ruleSet?.rules?.length) {
    return ruleSet;
  }

  const fallbackRules = terminal?.storageRulesByContainer?.[containerTypeKey] || [];
  return fallbackRules.length
    ? {
        id: `legacy-${containerTypeKey}`,
        name: containerTypeKey,
        rules: fallbackRules,
      }
    : null;
}

function computeCustomsCalculator(moduleData, formData, referenceData, options = {}) {
  const t = options.t || ((key) => key);
  const priceMode = normalizePriceMode(formData.priceMode);
  const quoteCurrency = normalizeCurrencyCode(
    formData.quoteCurrency,
    moduleData.settings.defaultQuoteCurrency
  );
  const exchangeRates = referenceData.exchangeRates;
  const storageDays = parseNumber(formData.storageDays, 0);
  const containerRows = buildTypedRows(
    moduleData.containerTypes || [],
    formData.containerRows || [],
    t,
    "calculator.unknownContainer"
  ).filter((row) => row.quantity > 0);
  const selectedPort =
    moduleData.ports.find((port) => port.id === formData.portId) || moduleData.ports[0] || null;
  const selectedTerminal =
    selectedPort?.terminals.find((terminal) => terminal.id === formData.terminalId) ||
    selectedPort?.terminals[0] ||
    null;
  const selectedShippingLine =
    moduleData.shippingLines.find((line) => line.id === formData.shippingLineId) ||
    moduleData.shippingLines[0] ||
    null;
  const availableYards = (moduleData.yards || []).filter(
    (yard) =>
      (!selectedPort || yard.portIds.includes(selectedPort.id)) &&
      (!selectedShippingLine || yard.shippingLineIds.includes(selectedShippingLine.id))
  );
  const selectedYard =
    availableYards.find((yard) => yard.id === formData.yardId) ||
    availableYards[0] ||
    null;
  const taxOverrides = formData.taxOverrides || {};

  const terminalFixedItems = [];
  for (const charge of selectedTerminal?.fixedCharges || []) {
    // O3: per_day charges multiply by storage days; per_occurrence are charged once.
    const perDay = charge.basis === "per_day";
    const required = Boolean(charge.required);
    const dayMultiplier = perDay
      ? [{ value: storageDays, label: t("calculator.partDays") }]
      : [];
    const parts = [];
    for (const row of containerRows) {
      const rateConfig = charge.groupRates?.[row.containerGroupKey];
      if (!rateConfig) {
        continue;
      }
      parts.push(
        buildRatePart({
          description: row.label,
          rateConfig,
          multipliers: [
            {
              value: row.quantity,
              label: t("calculator.partContainer", { label: row.label }),
            },
            ...dayMultiplier,
          ],
          quoteCurrency,
          exchangeRates,
        })
      );
    }
    // O3: optional flat (non-container) amount that coexists with groupRates.
    if (charge.amount != null && Number(charge.amount) !== 0) {
      parts.push(
        buildRatePart({
          description: charge.concept,
          rateConfig: {
            rate: Number(charge.amount),
            currency: charge.amountCurrency || quoteCurrency,
          },
          multipliers: dayMultiplier.length
            ? dayMultiplier
            : [{ value: 1, label: t("calculator.partFlat") }],
          quoteCurrency,
          exchangeRates,
        })
      );
    }
    // O3: required charges always render (even at 0); others skip when empty.
    if (!parts.length && !required) {
      continue;
    }
    const overrideKey = `customs:fixed:${charge.id}`;
    const taxRate = resolveTaxRate(charge.taxRate, taxOverrides, overrideKey);
    terminalFixedItems.push(
      buildCustomsItem({
        itemId: overrideKey,
        categoryKey: "terminalFixed",
        concept: charge.concept,
        note: charge.note,
        parts,
        taxRate,
        quoteCurrency,
        priceMode,
        explanation: t("customs.itemExplanationFixed", {
          terminal: selectedTerminal?.name || t("common.notConfigured"),
          taxRate: getTaxRateLabel(taxRate),
        }),
      })
    );
  }

  const terminalStorageItems = [];
  for (const row of containerRows) {
    const ruleSet = resolveTerminalStorageRuleSet(
      selectedTerminal,
      selectedShippingLine?.id,
      row.containerGroupKey
    );
    let coveredUntil = 0;
    for (const rule of ruleSet?.rules || []) {
      const window = getProgressiveRuleWindow(
        storageDays,
        rule.startDay,
        rule.endDay,
        coveredUntil
      );
      if (!window || window.dayCount <= 0) {
        continue;
      }
      coveredUntil = window.endDay;
      const ruleLabel = formatRuleDisplayLabel(rule);
      const overrideKey = "customs:storage";
      const taxRate = resolveTaxRate(rule.taxRate, taxOverrides, overrideKey);
      terminalStorageItems.push(
        buildCustomsItem({
          itemId: `customs:storage:${ruleSet.id}:${rule.id}`,
          categoryKey: "terminalStorage",
          concept: `${t("customs.variableFeeTitle")} ${row.label} ${ruleSet.name} ${ruleLabel}`,
          note: rule.note,
          parts: [
            buildRatePart({
              description: t("calculator.partDemurrageWindow", {
                label: row.label,
                days: window.dayCount,
              }),
              rateConfig: rule.rateConfig,
              multipliers: [
                { value: window.dayCount, label: t("calculator.partDays") },
                {
                  value: row.quantity,
                  label: t("calculator.partContainer", { label: row.label }),
                },
              ],
              quoteCurrency,
              exchangeRates,
            }),
          ],
          taxRate,
          quoteCurrency,
          priceMode,
          explanation: rule.freeRule
            ? t("customs.itemExplanationStorageFree", {
                terminal: selectedTerminal?.name || t("common.notConfigured"),
                ruleLabel,
              })
            : t("customs.itemExplanationStorage", {
                terminal: selectedTerminal?.name || t("common.notConfigured"),
                ruleLabel,
                taxRate: getTaxRateLabel(taxRate),
              }),
        })
      );
    }
  }

  const yardDropoffItems = [];
  for (const charge of selectedYard?.dropoffCharges || []) {
    const parts = [];
    for (const row of containerRows) {
      const rateConfig = charge.groupRates?.[row.containerGroupKey];
      if (!rateConfig) {
        continue;
      }
      parts.push(
        buildRatePart({
          description: row.label,
          rateConfig,
          multipliers: [
            {
              value: row.quantity,
              label: t("calculator.partContainer", { label: row.label }),
            },
          ],
          quoteCurrency,
          exchangeRates,
        })
      );
    }
    if (!parts.length) {
      continue;
    }
    const overrideKey = `customs:dropoff:${charge.id}`;
    const taxRate = resolveTaxRate(charge.taxRate, taxOverrides, overrideKey);
    yardDropoffItems.push(
      buildCustomsItem({
        itemId: overrideKey,
        categoryKey: "yardDropoff",
        concept: charge.concept,
        note: charge.note,
        parts,
        taxRate,
        quoteCurrency,
        priceMode,
        explanation: t("customs.itemExplanationDropoff", {
          yard: selectedYard?.name || t("common.notConfigured"),
          taxRate: getTaxRateLabel(taxRate),
        }),
      })
    );
  }

  const yardCustomsItems = [];
  for (const charge of selectedYard?.customsCharges || []) {
    const parts = [];
    for (const row of containerRows) {
      const rateConfig = charge.groupRates?.[row.containerGroupKey];
      if (!rateConfig) {
        continue;
      }
      parts.push(
        buildRatePart({
          description: row.label,
          rateConfig,
          multipliers: [
            {
              value: row.quantity,
              label: t("calculator.partContainer", { label: row.label }),
            },
          ],
          quoteCurrency,
          exchangeRates,
        })
      );
    }
    if (!parts.length) {
      continue;
    }
    const overrideKey = `customs:yard:${charge.id}`;
    const taxRate = resolveTaxRate(charge.taxRate, taxOverrides, overrideKey);
    yardCustomsItems.push(
      buildCustomsItem({
        itemId: overrideKey,
        categoryKey: "yardCustoms",
        concept: charge.concept,
        note: charge.note,
        parts,
        taxRate,
        quoteCurrency,
        priceMode,
        explanation: t("customs.itemExplanationYard", {
          yard: selectedYard?.name || t("common.notConfigured"),
          taxRate: getTaxRateLabel(taxRate),
        }),
      })
    );
  }

  const terminalFixed = finalizeCategory({
    key: "terminalFixed",
    title: t("customs.categories.terminalFixed"),
    items: terminalFixedItems,
    quoteCurrency,
    priceMode,
    t,
  });
  const terminalStorage = finalizeCategory({
    key: "terminalStorage",
    title: t("customs.categories.terminalStorage"),
    items: terminalStorageItems,
    quoteCurrency,
    priceMode,
    t,
  });
  const yardDropoff = finalizeCategory({
    key: "yardDropoff",
    title: t("customs.categories.yardDropoff"),
    items: yardDropoffItems,
    quoteCurrency,
    priceMode,
    t,
  });
  const yardCustoms = finalizeCategory({
    key: "yardCustoms",
    title: t("customs.categories.yardCustoms"),
    items: yardCustomsItems,
    quoteCurrency,
    priceMode,
    t,
  });

  const categories = [terminalFixed, terminalStorage, yardDropoff, yardCustoms];
  const totals = computeCategoryTotals(categories, priceMode);

  return {
    businessNature: formData.businessNature,
    priceMode,
    quoteCurrency,
    exchangeRates,
    storageDays,
    containerRows,
    selectedPort,
    selectedTerminal,
    selectedShippingLine,
    availableYards,
    selectedYard,
    terminalFixed,
    terminalStorage,
    yardDropoff,
    yardCustoms,
    pretaxTotal: totals.pretaxTotal,
    afterTaxTotal: totals.afterTaxTotal,
    total: totals.total,
    totalFormula:
      priceMode === "aftertax"
        ? t("customs.totalFormulaAftertax", {
            fixed: formatAmount(terminalFixed.pretaxTotal),
            variable: formatAmount(terminalStorage.pretaxTotal),
            dropoff: formatAmount(yardDropoff.pretaxTotal),
            yard: formatAmount(yardCustoms.pretaxTotal),
            total: formatAmount(totals.total),
            currency: quoteCurrency,
          })
        : t("customs.totalFormulaPretax", {
            fixed: formatAmount(terminalFixed.pretaxTotal),
            variable: formatAmount(terminalStorage.pretaxTotal),
            dropoff: formatAmount(yardDropoff.pretaxTotal),
            yard: formatAmount(yardCustoms.pretaxTotal),
            total: formatAmount(totals.total),
            currency: quoteCurrency,
          }),
    totalExplanation: t("customs.totalExplanation", {
      currency: quoteCurrency,
      date: exchangeRates?.asOfDate || t("common.notConfigured"),
      mode: priceMode === "aftertax" ? t("priceMode.aftertax") : t("priceMode.pretax"),
    }),
  };
}

const INLAND_DEFAULT_TAX_RATE = 0.16;

// Inland (Transporte) quote: pick the highest per-supplier rate for the chosen
// service type at the destination, multiply by quantity, apply IVA. Sencillo and
// Full are resolved independently and may come from different suppliers.
function computeInlandCalculator(moduleData, formData, options = {}) {
  const t = options.t || ((key) => key);
  const priceMode = normalizePriceMode(formData.priceMode);
  const quoteCurrency = "MXN";
  // S2: serviceType is now one of 6 vehicle tiers (sencillo/full map to the
  // legacy fields; the other 4 read rateEntry.vehiclePrices). Unknown -> sencillo.
  const serviceType = normalizeVehicleType(formData.serviceType);
  const quantity = Math.max(0, parseNumber(formData.quantity, 1));
  // R2 short-haul / drayage (burreo): optional add-on, OFF by default so existing
  // flows (incl. the quote pull) are unchanged.
  const includeBurreo = Boolean(formData.includeBurreo);

  const destination =
    (moduleData.destinations || []).find((dest) => dest.id === formData.destinationId) ||
    null;

  const entries = (moduleData.rateEntries || []).filter(
    (entry) => entry.enabled && entry.destinationId === formData.destinationId
  );

  const allEntries = entries.map((entry) => ({
    proveedor: entry.proveedor,
    sencillo: entry.sencillo,
    full: entry.full,
    cliente: entry.cliente,
    commodity: entry.commodity,
    codigoCw: entry.codigoCw,
    note: entry.note,
  }));

  const overrideRaw = formData.taxRateOverride;
  const taxRate =
    overrideRaw === undefined || overrideRaw === "" || overrideRaw === "default"
      ? INLAND_DEFAULT_TAX_RATE
      : normalizeTaxRate(overrideRaw, INLAND_DEFAULT_TAX_RATE);
  const taxRateLabel = getTaxRateLabel(taxRate);

  const candidates = entries.filter((entry) => getVehiclePrice(entry, serviceType) !== null);

  if (!destination || !candidates.length) {
    return {
      noRate: true,
      // Destination exists but this vehicle tier has no rate yet -> "Pendiente".
      pendiente: Boolean(destination) && !candidates.length,
      destination,
      serviceType,
      quantity,
      quoteCurrency,
      priceMode,
      taxRate,
      taxRateLabel,
      allEntries,
      pretaxTotal: 0,
      afterTaxTotal: 0,
      total: 0,
      maxRate: null,
      maxProvider: null,
      includeBurreo,
      burreoRate: 0,
      burreoTotal: 0,
      totalExplanation: t("inland.noRateExplanation", {
        service: vehicleLabel(t, serviceType),
      }),
    };
  }

  let best = candidates[0];
  for (const entry of candidates) {
    if (Number(getVehiclePrice(entry, serviceType)) > Number(getVehiclePrice(best, serviceType))) {
      best = entry;
    }
  }
  const maxRate = Number(getVehiclePrice(best, serviceType));
  const maxProvider = best.proveedor;

  // Highest burreo[serviceType] across candidates (same max-across-suppliers
  // basis as the main rate; may originate from a different entry).
  let burreoRate = 0;
  for (const entry of candidates) {
    const value = entry.burreo && entry.burreo[serviceType];
    if (value !== null && value !== undefined && Number(value) > burreoRate) {
      burreoRate = Number(value);
    }
  }
  const burreoTotal = includeBurreo ? roundMoney(burreoRate * quantity) : 0;

  const pretaxTotal = roundMoney(maxRate * quantity + burreoTotal);
  const afterTaxTotal = roundMoney(pretaxTotal * (1 + taxRate));
  const total = priceMode === "aftertax" ? afterTaxTotal : pretaxTotal;

  const baseFormula = `${formatAmount(maxRate)} × ${quantity}`;
  const burreoPart =
    includeBurreo && burreoTotal > 0
      ? ` + ${formatAmount(burreoRate)} × ${quantity} (burreo)`
      : "";
  const totalFormula =
    priceMode === "aftertax"
      ? `(${baseFormula}${burreoPart}) × (1 + ${taxRateLabel}) = ${formatAmount(total)} ${quoteCurrency}`
      : `${baseFormula}${burreoPart} = ${formatAmount(total)} ${quoteCurrency}`;

  return {
    noRate: false,
    pendiente: false,
    destination,
    serviceType,
    quantity,
    quoteCurrency,
    priceMode,
    maxRate,
    maxProvider,
    includeBurreo,
    burreoRate,
    burreoTotal,
    taxRate,
    taxRateLabel,
    pretaxTotal,
    afterTaxTotal,
    total,
    allEntries,
    totalFormula,
    totalExplanation: t("inland.totalExplanation", {
      service: vehicleLabel(t, serviceType),
      provider: maxProvider,
      mode: priceMode === "aftertax" ? t("priceMode.aftertax") : t("priceMode.pretax"),
    }),
  };
}

module.exports = {
  computeCalculator: computeHandoverCalculator,
  computeCustomsCalculator,
  computeHandoverCalculator,
  computeInlandCalculator,
  formatTierLabel,
  parseNumber,
  roundMoney,
};
