const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";

const { createApp } = require("../src/server");
const { getShippingData } = require("../src/lib/store");

const dataFile = path.join(__dirname, "../data/shipping-lines.json");

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  store(headers) {
    const setCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie")
          ? headers.get("set-cookie").split(/,(?=[^;]+?=)/)
          : [];

    for (const cookie of setCookies) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      if (separator < 0) {
        continue;
      }
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function buildFormBody(entries) {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item == null ? "" : String(item));
      }
      continue;
    }
    params.append(key, value == null ? "" : String(value));
  }
  return params;
}

async function request(baseUrl, urlPath, { method = "GET", formEntries, jar } = {}) {
  const headers = {};
  if (jar?.header()) {
    headers.cookie = jar.header();
  }

  let body;
  if (formEntries) {
    body = buildFormBody(formEntries);
    headers["content-type"] = "application/x-www-form-urlencoded";
  }

  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body,
    redirect: "manual",
  });

  jar?.store(response.headers);
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    text,
  };
}

function expectContains(haystack, needle, message) {
  assert.ok(haystack.includes(needle), `${message}: missing "${needle}"`);
}

function expectNotContains(haystack, needle, message) {
  assert.ok(!haystack.includes(needle), `${message}: unexpected "${needle}"`);
}

function buildHandoverAdminForm(moduleData, line) {
  const entries = [
    ["invoiceNote", line.invoiceNote || ""],
    ["demurrageCutoffHandledBy", line.demurrageCutoffHandledBy],
    ["benefitExpiresAt", line.guarantee.benefitExpiresAt || ""],
    ["benefitNote", line.guarantee.benefitNote || ""],
    ["guaranteeTaxRate", line.guarantee.taxRate],
  ];

  if (line.invoiceToConsigneeOnly) {
    entries.push(["invoiceToConsigneeOnly", "on"]);
  }
  if (line.guarantee.benefitEnabled) {
    entries.push(["benefitEnabled", "on"]);
  }

  for (const charge of line.localCharges || []) {
    entries.push([`charge_tax_${charge.id}`, charge.taxRate]);
    if (charge.blRate) {
      entries.push([`charge_bl_${charge.id}_rate`, charge.blRate.rate]);
      entries.push([`charge_bl_${charge.id}_currency`, charge.blRate.currency]);
    }
    for (const group of line.containerGroups || []) {
      const rate = charge.groupRates?.[group.key];
      if (!rate) {
        continue;
      }
      entries.push([`charge_${charge.id}_${group.key}_rate`, rate.rate]);
      entries.push([`charge_${charge.id}_${group.key}_currency`, rate.currency]);
    }
  }

  for (const group of line.containerGroups || []) {
    const rate = line.guarantee.ratesByGroup?.[group.key];
    if (!rate) {
      continue;
    }
    entries.push([`guarantee_${group.key}_rate`, rate.rate]);
    entries.push([`guarantee_${group.key}_currency`, rate.currency]);
  }

  for (const type of moduleData.containerTypes || []) {
    entries.push([
      `demurrage_assignment_${type.key}`,
      line.demurrage.assignmentsByContainerType?.[type.key] ||
        line.demurrage.ruleSets?.[0]?.id ||
        "",
    ]);
  }

  for (const ruleSet of line.demurrage.ruleSets || []) {
    entries.push([`demurrage_set_${ruleSet.id}_name`, ruleSet.name]);
    for (const rule of ruleSet.rules || []) {
      entries.push([`rule_set_${ruleSet.id}_${rule.id}_end`, rule.endDay ?? ""]);
      entries.push([`rule_set_${ruleSet.id}_${rule.id}_tax`, rule.taxRate]);
      entries.push([`rule_set_${ruleSet.id}_${rule.id}_rate`, rule.rateConfig?.rate ?? 0]);
      entries.push([
        `rule_set_${ruleSet.id}_${rule.id}_currency`,
        rule.rateConfig?.currency || "MXN",
      ]);
    }
  }

  return entries;
}

function buildCustomsAdminForm(moduleData) {
  const entries = [];

  for (const line of moduleData.shippingLines || []) {
    entries.push([`customs_line_note_${line.id}`, line.notes || ""]);
    for (const yardId of line.yardIds || []) {
      entries.push([`shippingLine_yardIds_${line.id}`, yardId]);
    }
  }

  for (const port of moduleData.ports || []) {
    entries.push([`port_name_${port.id}`, port.name]);
    entries.push([`port_note_${port.id}`, port.note || ""]);
    for (const terminal of port.terminals || []) {
      entries.push([`terminal_name_${terminal.id}`, terminal.name]);
      entries.push([`terminal_note_${terminal.id}`, terminal.note || ""]);
      for (const charge of terminal.fixedCharges || []) {
        entries.push([`terminal_charge_concept_${terminal.id}_${charge.id}`, charge.concept]);
        entries.push([`terminal_charge_note_${terminal.id}_${charge.id}`, charge.note || ""]);
        entries.push([`terminal_charge_tax_${terminal.id}_${charge.id}`, charge.taxRate]);
        for (const type of moduleData.containerTypes || []) {
          const rate = charge.groupRates?.[type.key];
          if (!rate) {
            continue;
          }
          entries.push([
            `terminal_charge_${terminal.id}_${charge.id}_${type.key}_rate`,
            rate.rate,
          ]);
          entries.push([
            `terminal_charge_${terminal.id}_${charge.id}_${type.key}_currency`,
            rate.currency,
          ]);
        }
      }

      for (const type of moduleData.containerTypes || []) {
        for (const rule of terminal.storageRulesByContainer?.[type.key] || []) {
          entries.push([
            `terminal_rule_${terminal.id}_${type.key}_${rule.id}_end`,
            rule.endDay ?? "",
          ]);
          entries.push([
            `terminal_rule_${terminal.id}_${type.key}_${rule.id}_tax`,
            rule.taxRate,
          ]);
          entries.push([
            `terminal_rule_${terminal.id}_${type.key}_${rule.id}_rate`,
            rule.rateConfig?.rate ?? 0,
          ]);
          entries.push([
            `terminal_rule_${terminal.id}_${type.key}_${rule.id}_currency`,
            rule.rateConfig?.currency || "MXN",
          ]);
        }
      }
    }
  }

  for (const yard of moduleData.yards || []) {
    entries.push([`yard_name_${yard.id}`, yard.name]);
    entries.push([`yard_note_${yard.id}`, yard.note || ""]);
    for (const portId of yard.portIds || []) {
      entries.push([`yard_portIds_${yard.id}`, portId]);
    }
    for (const shippingLineId of yard.shippingLineIds || []) {
      entries.push([`yard_shippingLineIds_${yard.id}`, shippingLineId]);
    }

    for (const charge of yard.dropoffCharges || []) {
      entries.push([`yard_dropoff_concept_${yard.id}_${charge.id}`, charge.concept]);
      entries.push([`yard_dropoff_note_${yard.id}_${charge.id}`, charge.note || ""]);
      entries.push([`yard_dropoff_tax_${yard.id}_${charge.id}`, charge.taxRate]);
      for (const type of moduleData.containerTypes || []) {
        const rate = charge.groupRates?.[type.key];
        if (!rate) {
          continue;
        }
        entries.push([`yard_dropoff_${yard.id}_${charge.id}_${type.key}_rate`, rate.rate]);
        entries.push([
          `yard_dropoff_${yard.id}_${charge.id}_${type.key}_currency`,
          rate.currency,
        ]);
      }
    }

    for (const charge of yard.customsCharges || []) {
      entries.push([`yard_customs_concept_${yard.id}_${charge.id}`, charge.concept]);
      entries.push([`yard_customs_note_${yard.id}_${charge.id}`, charge.note || ""]);
      entries.push([`yard_customs_tax_${yard.id}_${charge.id}`, charge.taxRate]);
      for (const type of moduleData.containerTypes || []) {
        const rate = charge.groupRates?.[type.key];
        if (!rate) {
          continue;
        }
        entries.push([`yard_customs_${yard.id}_${charge.id}_${type.key}_rate`, rate.rate]);
        entries.push([
          `yard_customs_${yard.id}_${charge.id}_${type.key}_currency`,
          rate.currency,
        ]);
      }
    }
  }

  return entries;
}

async function main() {
  const originalData = await fs.readFile(dataFile, "utf8");
  const seededData = JSON.parse(originalData);
  seededData.exchangeRates = {
    provider: seededData.exchangeRates?.provider || "Fixture",
    docsUrl: seededData.exchangeRates?.docsUrl || "https://example.test/fx",
    asOfDate: seededData.exchangeRates?.asOfDate || "2026-04-24",
    lastCheckedAt: seededData.exchangeRates?.lastCheckedAt || "2026-04-24T00:00:00.000Z",
    lastError: null,
    defaultQuoteCurrency: "MXN",
    pairs: [
      { base: "USD", quote: "MXN", rate: 17.2 },
      { base: "MXN", quote: "USD", rate: 1 / 17.2 },
    ],
  };
  await fs.writeFile(dataFile, JSON.stringify(seededData, null, 2), "utf8");
  const app = createApp();
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const publicJar = new CookieJar();

  try {
    let response = await request(baseUrl, "/", { jar: publicJar });
    assert.equal(response.status, 302);
    assert.equal(response.location, "/workbench/handover");

    response = await request(baseUrl, "/login", { jar: publicJar });
    assert.equal(response.status, 302);
    assert.equal(response.location, "/workbench/handover");

    response = await request(baseUrl, "/workbench/handover", { jar: publicJar });
    assert.equal(response.status, 200);
    expectContains(response.text, "EXPRESS LINE", "brand wordmark");
    expectContains(response.text, "Antropy AI", "brand submark");
    expectContains(response.text, "data-theme-toggle", "theme toggle");
    expectContains(response.text, "compact-language-switcher", "compact language switcher");
    expectContains(response.text, "data-handover-line-select", "handover shipping line select");
    expectContains(response.text, 'name="businessNature" value="handover_only"', "hidden default business nature");
    expectContains(response.text, "40GP - Forty foot general purpose", "standard container type");
    expectContains(response.text, "45OT - Forty five foot open top", "standard 45 foot container type");
    expectNotContains(response.text, "业务性质", "hidden business nature selector");
    expectContains(response.text, "每项费用税率", "handover tax overrides");
    expectContains(response.text, "data-add-row", "handover add row button");
    expectContains(response.text, "tax-override-card", "handover visible tax overrides");
    expectContains(response.text, "field-help", "handover field help");
    assert.ok(
      response.text.indexOf('data-container-rows') <
        response.text.indexOf('name="demurrageDays"'),
      "handover demurrage days field follows container rows"
    );

    response = await request(baseUrl, "/workbench/handover", {
      method: "POST",
      jar: publicJar,
      formEntries: [
        ["shippingLineId", "cma-cgm"],
        ["businessNature", "handover_customs"],
        ["blCount", 1],
        ["demurrageDays", 9],
        ["priceMode", "aftertax"],
        ["quoteCurrency", "MXN"],
        ["containerGroupKey[]", "gp-hq-dc"],
        ["containerCount[]", 2],
      ],
    });
    assert.equal(response.status, 200);
    expectContains(response.text, "继续到清关", "continuous workflow CTA");
    expectContains(response.text, "连续业务", "continuous workflow banner");

    response = await request(baseUrl, "/workbench/handover", {
      method: "POST",
      jar: publicJar,
      formEntries: [
        ["shippingLineId", "cosco"],
        ["businessNature", "handover_only"],
        ["blCount", 1],
        ["demurrageDays", 4],
        ["priceMode", "pretax"],
        ["quoteCurrency", "MXN"],
        ["containerGroupKey[]", "45OT"],
        ["containerCount[]", 1],
      ],
    });
    assert.equal(response.status, 200);
    expectContains(response.text, "45OT - Forty five foot open top", "global handover container type");

    response = await request(baseUrl, "/workbench/customs?useLinked=1", {
      jar: publicJar,
    });
    assert.equal(response.status, 200);
    expectContains(response.text, "清关一页式工作台", "customs page");
    expectContains(response.text, 'value="cma-cgm" selected', "linked shipping line");
    expectContains(response.text, 'value="gp-hq-dc" selected', "linked container type");
    expectContains(response.text, "tax-override-card", "customs visible tax overrides");

    response = await request(baseUrl, "/workbench/customs", {
      method: "POST",
      jar: publicJar,
      formEntries: [
        ["businessNature", "handover_customs"],
        ["shippingLineId", "cma-cgm"],
        ["portId", "manzanillo"],
        ["terminalId", "contecon-manzanillo"],
        ["yardId", "yard-mzo-norte"],
        ["storageDays", 12],
        ["priceMode", "aftertax"],
        ["quoteCurrency", "MXN"],
        ["containerGroupKey[]", "gp-hq-dc"],
        ["containerCount[]", 2],
      ],
    });
    assert.equal(response.status, 200);
    expectContains(response.text, "码头固定费", "customs fixed fee");
    expectContains(response.text, "落柜", "customs dropoff");
    expectContains(response.text, "清关堆场费", "customs yard fee");

    response = await request(baseUrl, "/admin/customs/shipping-lines", {
      jar: publicJar,
    });
    assert.equal(response.status, 200);
    expectContains(response.text, "船公司与场站映射", "public admin access");
    expectContains(response.text, "新增阶梯", "customs add rule button");
    expectContains(response.text, "section-jump-nav", "customs section navigation");
    expectContains(response.text, "data-admin-form", "customs dirty form guard");
    expectContains(response.text, "data-confirm-submit", "customs delete confirmation");

    response = await request(baseUrl, "/admin/handover/shipping-lines/cma-cgm", {
      jar: publicJar,
    });
    assert.equal(response.status, 200);
    expectContains(response.text, "新增阶梯", "handover add rule button");
    expectContains(response.text, "柜型规则分配", "handover rule assignment table");
    expectContains(response.text, "新增规则集", "handover add rule set button");
    expectContains(response.text, 'data-scroll-scope="admin"', "admin scroll scope");
    expectContains(response.text, 'data-scroll-panel="admin-list"', "admin list scroll panel");
    expectContains(response.text, 'data-scroll-panel="admin-detail"', "admin detail scroll panel");
    expectContains(response.text, "data-admin-filter", "handover admin search");
    expectContains(response.text, "sticky-save-bar", "handover sticky save bar");
    expectContains(response.text, "data-confirm-submit", "handover delete confirmation");

    response = await request(baseUrl, "/workbench/handover", {
      method: "POST",
      jar: publicJar,
      formEntries: [
        ["shippingLineId", "cma-cgm"],
        ["businessNature", "handover_only"],
        ["blCount", -3],
        ["demurrageDays", -9],
        ["priceMode", "pretax"],
        ["quoteCurrency", "MXN"],
        ["containerGroupKey[]", "40GP"],
        ["containerCount[]", -2],
      ],
    });
    assert.equal(response.status, 200);
    expectContains(response.text, "总数", "negative handover input still renders");

    let shippingData = await getShippingData();
    const handoverLine = shippingData.modules.handover.shippingLines[0];
    const handoverRuleSetId = handoverLine.demurrage.ruleSets[0].id;
    const beforeHandoverRuleCount =
      handoverLine.demurrage.ruleSets[0].rules.length;

    response = await request(
      baseUrl,
      `/admin/handover/shipping-lines/${handoverLine.id}/demurrage-rule-sets/${handoverRuleSetId}/add`,
      {
        method: "POST",
        jar: publicJar,
      }
    );
    assert.equal(response.status, 302);

    shippingData = await getShippingData();
    const afterAddHandoverCount =
      shippingData.modules.handover.shippingLines[0].demurrage.ruleSets[0].rules.length;
    assert.equal(afterAddHandoverCount, beforeHandoverRuleCount + 1);

    const addedHandoverRule =
      shippingData.modules.handover.shippingLines[0].demurrage.ruleSets[0].rules.at(-1);
    response = await request(
      baseUrl,
      `/admin/handover/shipping-lines/${handoverLine.id}/demurrage-rule-sets/${handoverRuleSetId}/${addedHandoverRule.id}/delete`,
      {
        method: "POST",
        jar: publicJar,
      }
    );
    assert.equal(response.status, 302);
    shippingData = await getShippingData();
    assert.equal(
      shippingData.modules.handover.shippingLines[0].demurrage.ruleSets[0].rules.length,
      beforeHandoverRuleCount
    );

    const beforeRuleSetCount =
      shippingData.modules.handover.shippingLines[0].demurrage.ruleSets.length;
    response = await request(
      baseUrl,
      `/admin/handover/shipping-lines/${handoverLine.id}/demurrage-rule-sets/add`,
      {
        method: "POST",
        jar: publicJar,
      }
    );
    assert.equal(response.status, 302);
    shippingData = await getShippingData();
    assert.equal(
      shippingData.modules.handover.shippingLines[0].demurrage.ruleSets.length,
      beforeRuleSetCount + 1
    );
    const newRuleSetId =
      shippingData.modules.handover.shippingLines[0].demurrage.ruleSets.at(-1).id;
    const assignmentForm = buildHandoverAdminForm(
      shippingData.modules.handover,
      shippingData.modules.handover.shippingLines[0]
    );
    const assignmentKey = `demurrage_assignment_${shippingData.modules.handover.containerTypes[0].key}`;
    const assignmentIndex = assignmentForm.findIndex(([key]) => key === assignmentKey);
    assignmentForm[assignmentIndex][1] = newRuleSetId;
    response = await request(
      baseUrl,
      `/admin/handover/shipping-lines/${handoverLine.id}`,
      {
        method: "POST",
        jar: publicJar,
        formEntries: assignmentForm,
      }
    );
    assert.equal(response.status, 302);
    shippingData = await getShippingData();
    assert.equal(
      shippingData.modules.handover.shippingLines[0].demurrage.assignmentsByContainerType[
        shippingData.modules.handover.containerTypes[0].key
      ],
      newRuleSetId
    );

    const invalidHandoverForm = buildHandoverAdminForm(
      shippingData.modules.handover,
      shippingData.modules.handover.shippingLines[0]
    );
    const firstHandoverRule =
      shippingData.modules.handover.shippingLines[0].demurrage.ruleSets[0].rules[0];
    const invalidIndex = invalidHandoverForm.findIndex(
      ([key]) => key === `rule_set_${handoverRuleSetId}_${firstHandoverRule.id}_end`
    );
    invalidHandoverForm[invalidIndex][1] = 0;

    response = await request(
      baseUrl,
      `/admin/handover/shipping-lines/${handoverLine.id}`,
      {
        method: "POST",
        jar: publicJar,
        formEntries: invalidHandoverForm,
      }
    );
    assert.equal(response.status, 302);
    response = await request(baseUrl, response.location, { jar: publicJar });
    expectContains(response.text, "阶梯区间无效", "handover validation");

    const validHandoverForm = buildHandoverAdminForm(
      shippingData.modules.handover,
      shippingData.modules.handover.shippingLines[0]
    );
    response = await request(
      baseUrl,
      `/admin/handover/shipping-lines/${handoverLine.id}`,
      {
        method: "POST",
        jar: publicJar,
        formEntries: validHandoverForm,
      }
    );
    assert.equal(response.status, 302);

    shippingData = await getShippingData();
    const terminal =
      shippingData.modules.customs.ports[0].terminals[0];
    const customsGroupKey = shippingData.modules.customs.containerTypes[0].key;
    const beforeCustomsRuleCount =
      terminal.storageRulesByContainer[customsGroupKey].length;

    response = await request(
      baseUrl,
      `/admin/customs/terminals/${terminal.id}/storage/${customsGroupKey}/add`,
      {
        method: "POST",
        jar: publicJar,
      }
    );
    assert.equal(response.status, 302);
    shippingData = await getShippingData();
    const updatedTerminal =
      shippingData.modules.customs.ports[0].terminals[0];
    assert.equal(
      updatedTerminal.storageRulesByContainer[customsGroupKey].length,
      beforeCustomsRuleCount + 1
    );

    const addedCustomsRule =
      updatedTerminal.storageRulesByContainer[customsGroupKey].at(-1);
    response = await request(
      baseUrl,
      `/admin/customs/terminals/${terminal.id}/storage/${customsGroupKey}/${addedCustomsRule.id}/delete`,
      {
        method: "POST",
        jar: publicJar,
      }
    );
    assert.equal(response.status, 302);
    shippingData = await getShippingData();
    assert.equal(
      shippingData.modules.customs.ports[0].terminals[0].storageRulesByContainer[
        customsGroupKey
      ].length,
      beforeCustomsRuleCount
    );

    const customsForm = buildCustomsAdminForm(shippingData.modules.customs);
    const firstCustomsRule =
      shippingData.modules.customs.ports[0].terminals[0].storageRulesByContainer[
        customsGroupKey
      ][0];
    const customsInvalidIndex = customsForm.findIndex(
      ([key]) =>
        key ===
        `terminal_rule_${terminal.id}_${customsGroupKey}_${firstCustomsRule.id}_end`
    );
    customsForm[customsInvalidIndex][1] = 0;

    response = await request(baseUrl, "/admin/customs/shipping-lines", {
      method: "POST",
      jar: publicJar,
      formEntries: customsForm,
    });
    assert.equal(response.status, 302);
    response = await request(baseUrl, response.location, { jar: publicJar });
    expectContains(response.text, "阶梯区间无效", "customs validation");

    const validCustomsForm = buildCustomsAdminForm(shippingData.modules.customs);
    response = await request(baseUrl, "/admin/customs/shipping-lines", {
      method: "POST",
      jar: publicJar,
      formEntries: validCustomsForm,
    });
    assert.equal(response.status, 302);

    response = await request(baseUrl, "/workbench/customs?lang=es", {
      jar: publicJar,
    });
    expectContains(response.text, "Mesa integral de despacho", "spanish customs");

    console.log("smoke-test-ok");
  } finally {
    await fs.writeFile(dataFile, originalData, "utf8");
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
