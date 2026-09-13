// Editable quote cargo types: real HTTP settings/draft writes in an isolated
// JSON DATA_DIR, plus the real PDF HTML and relational serialization paths.
// No production connection, seed mutation, browser launch, or external request.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.SKIP_FX_REFRESH = "1";
process.env.STORAGE_DRIVER = "json";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jose-cargo-types-test-"));
process.env.DATA_DIR = tmpDir;

const { createApp } = require("../src/server");
const { BoundedSessionStore } = require("../src/lib/bounded-session-store");
const { getShippingData, normalizeShippingData } = require("../src/lib/store");
const { QUOTE_CARGO_TYPE_OPTIONS, normalizeQuoteCargoTypes } = require("../src/lib/quote");
const { buildQuoteFormData, assembleQuoteView } = require("../src/lib/views");
const { renderQuoteHtml } = require("../src/lib/quote-pdf");
const { decompose, assemble } = require("../src/lib/db/relational-map");
const { escapeXML } = require("ejs");

const dataFile = path.join(tmpDir, "shipping-lines.json");
const customLabel = '项目货物 <img src=x onerror="alert(1)"> & 特种运输';
const renamedLabel = "项目货物运输（已确认）";
const customCode = "PROJECT-LOAD";
let passed = 0;
let baseUrl;
const cookies = new Map();
const ok = (message) => { passed += 1; console.log("  PASS ", message); };
const readQuote = () => getShippingData().then((data) => data.modules.quote);
const diskContents = () => fs.readFileSync(dataFile, "utf8");

async function request(urlPath, { method = "GET", form } = {}) {
  const headers = {};
  if (cookies.size) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  let body;
  if (form) {
    body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      for (const entry of Array.isArray(value) ? value : [value]) body.append(key, String(entry ?? ""));
    }
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method, headers, body, redirect: "manual", signal: AbortSignal.timeout(15000),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const separator = pair.indexOf("=");
    if (separator >= 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  return { status: response.status, html: await response.text() };
}

function cargoForm(entries, extra = {}) {
  return {
    cargoTypesPresent: "1",
    "cargo_code[]": entries.map((entry) => entry.code),
    "cargo_label[]": entries.map((entry) => entry.label),
    "cargo_enabled[]": entries.map((entry) => entry.enabled ? "1" : "0"),
    ...extra,
  };
}

async function saveCargo(entries, extra = {}) {
  const response = await request("/admin/quote/settings", {
    method: "POST", form: cargoForm(entries, extra),
  });
  assert.equal(response.status, 302, "valid cargo configuration redirects after saving");
  return readQuote();
}

function selectOptions(html, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const select = html.match(new RegExp(`<select\\b[^>]*\\bname=["']${escapedName}["'][^>]*>([\\s\\S]*?)<\\/select>`, "i"));
  assert.ok(select, `select ${name} rendered`);
  return [...select[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((match) => ({
    value: match[1].match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "",
    label: match[2].trim(),
    selected: /\bselected\b/i.test(match[1]),
  }));
}

async function frontOptions() {
  const response = await request("/workbench/quote");
  assert.equal(response.status, 200);
  return selectOptions(response.html, "cargoType");
}

async function saveDraft(number, cargoType) {
  const response = await request("/workbench/quote", {
    method: "POST", form: { action: "saveDraft", quotationNumber: number, cargoType },
  });
  assert.equal(response.status, 200, `draft ${number} saves without posted line items`);
  const draft = (await readQuote()).drafts.find((entry) => entry.number === number);
  assert.ok(draft, `draft ${number} exists in a fresh store read`);
  return draft;
}

async function main() {
  const sessionStore = new BoundedSessionStore();
  let server;
  try {
    assert.deepEqual(normalizeQuoteCargoTypes(undefined), QUOTE_CARGO_TYPE_OPTIONS.map((code) => ({ code, label: code, enabled: true })));
    assert.equal(normalizeQuoteCargoTypes(undefined).length, 8, "missing legacy settings retain eight choices");
    assert.deepEqual(normalizeQuoteCargoTypes([]), [], "explicit empty list does not fall back");
    ok("legacy missing configuration falls back to eight; explicit empty remains empty");

    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/shipping-lines.json"), "utf8"));
    seed.modules.quote = {
      settings: {
        quoteNumberPrefix: "CARGO-", quoteNumberSuffix: "-TEST", quoteNumberPad: 4,
        lastQuoteSeq: 19,
        headerDefaults: { department: "OCEAN", transportMode: "SEA", incoterm: "CIF", cargoType: "FCL", quoteMode: "ocean_mexico" },
      },
      notes: [{ id: "cargo-preserved-note", en: "Preserve this remark", zh: "保留备注", es: "Conservar nota" }],
      drafts: [{ id: "cargo-legacy", number: "CARGO-LEGACY", header: { cargoType: "LEGACY-RETIRED" }, lineItems: [] }],
    };
    fs.writeFileSync(dataFile, JSON.stringify(normalizeShippingData(seed), null, 2));
    const initial = await readQuote();
    const notesBefore = structuredClone(initial.notes);
    const defaultsBefore = structuredClone(initial.settings.headerDefaults);
    assert.equal(defaultsBefore.transportMode, "SEA", "fixture has a meaningful transport-mode default");

    const app = createApp({ sessionStore });
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      listener.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual((await frontOptions()).filter((option) => option.value).map((option) => option.value), QUOTE_CARGO_TYPE_OPTIONS);
    const admin = await request("/admin/quote/settings");
    assert.equal(admin.status, 200);
    assert.match(admin.html, /name="cargoTypesPresent"/);
    assert.match(admin.html, /name="cargo_code\[\]"/);
    ok("legacy frontend and admin editor render through the real routes");

    const entries = [
      { code: "FCL", label: "整柜运输", enabled: true },
      { code: "LCL", label: "拼箱（停用）", enabled: false },
      { code: customCode.toLowerCase(), label: customLabel, enabled: true },
    ];
    let quote = await saveCargo(entries, { hd_cargoType: "FCL" });
    const expectedEntries = entries.map((entry) => ({ ...entry, code: entry.code.toUpperCase() }));
    assert.deepEqual(quote.settings.cargoTypes, expectedEntries);
    assert.deepEqual(quote.notes, notesBefore, "cargo-only save preserves unrelated note library");
    assert.deepEqual(quote.settings.headerDefaults, defaultsBefore, "cargo-only save preserves unrelated header defaults");
    assert.equal(quote.settings.quoteNumberPrefix, "CARGO-");
    assert.equal(quote.settings.lastQuoteSeq, 19);
    const options = await frontOptions();
    assert.deepEqual(options.filter((option) => option.value).map((option) => [option.value, option.label]), [
      ["FCL", "整柜运输"], [customCode, escapeXML(customLabel)],
    ]);
    assert.equal(options.find((option) => option.selected)?.value, "FCL");
    const savedAdmin = await request("/admin/quote/settings");
    assert.equal(savedAdmin.status, 200);
    assert.ok(savedAdmin.html.includes(escapeXML(customLabel)), "admin renders escaped configured label");
    assert.ok(!savedAdmin.html.includes(customLabel), "admin does not interpolate raw HTML labels");
    const beforeRead = diskContents();
    await frontOptions();
    await request("/admin/quote/settings");
    assert.equal(diskContents(), beforeRead, "viewing either page does not change stored settings");
    ok("add/save/reload: configured names, active choices, default, escaping and unrelated settings preserved");

    const customDraft = await saveDraft("CARGO-CUSTOM", customCode);
    assert.equal(customDraft.header.cargoType, customCode, "custom code wins over default even without posted rows");
    assert.equal(customDraft.header.cargoTypeLabel, customLabel, "custom draft captures confirmed name");
    const recompute = await request("/workbench/quote", { method: "POST", form: { cargoType: customCode } });
    assert.equal(recompute.status, 200);
    assert.equal(selectOptions(recompute.html, "cargoType").find((option) => option.selected)?.value, customCode);
    for (const [name, value] of [["BLANK", ""], ["DISABLED", "LCL"], ["UNKNOWN", "UNKNOWN-CARGO"]]) {
      const draft = await saveDraft(`CARGO-${name}`, value);
      assert.equal(draft.header.cargoType, "", `${name} submission does not fall back to configured FCL default`);
      assert.ok(!draft.header.cargoTypeLabel, `${name} submission cannot retain a stale name`);
    }
    ok("custom recompute/draft works; explicit blank, disabled and unknown submissions cannot become defaults");

    const invalidCases = [
      ["duplicate normalized codes", [{ code: "DUP", label: "One", enabled: true }, { code: "dup", label: "Two", enabled: false }]],
      ["blank name", [{ code: "BAD", label: "   ", enabled: true }]],
      ["long name", [{ code: "BAD", label: "x".repeat(121), enabled: true }]],
      ["blank code", [{ code: "", label: "Name", enabled: true }]],
      ["unsafe code", [{ code: "<SCRIPT>", label: "Name", enabled: true }]],
      ["invalid initial code character", [{ code: "_BAD", label: "Name", enabled: true }]],
      ["long code", [{ code: "A".repeat(33), label: "Name", enabled: true }]],
      ["too many rows", Array.from({ length: 101 }, (_, index) => ({ code: `ROW${index}`, label: `Name ${index}`, enabled: false }))],
    ];
    for (const [description, invalidEntries] of invalidCases) {
      const before = diskContents();
      const response = await request("/admin/quote/settings", {
        method: "POST", form: cargoForm(invalidEntries, { quoteNumberPrefix: "MUST-NOT-SAVE" }),
      });
      assert.equal(response.status, 400, `${description} rerenders validation failure`);
      assert.match(response.html, /name="cargoTypesPresent"/, `${description} retains the editor`);
      assert.equal(diskContents(), before, `${description} produces no partial writes`);
      assert.deepEqual((await readQuote()).settings.cargoTypes, expectedEntries);
    }
    ok(`invalid configuration: ${invalidCases.length} failures rerender 400 without partial writes`);

    const beforeDuplicate = diskContents();
    const duplicateResponse = await request("/admin/quote/settings", {
      method: "POST",
      form: cargoForm([...expectedEntries, { code: "FCL", label: "New duplicate", enabled: false }]),
    });
    assert.equal(duplicateResponse.status, 400);
    assert.equal(diskContents(), beforeDuplicate, "duplicate of an existing code does not write");
    const cargoEditor = duplicateResponse.html.match(/<section\b[^>]*\bdata-cargo-editor[^>]*>([\s\S]*?)<\/section>/)?.[1];
    assert.ok(cargoEditor, "validation rerender retains cargo editor");
    const duplicateRows = cargoEditor.split(/<div\b[^>]*\bdata-cargo-row>/).slice(1).filter((row) => {
      const input = row.match(/<input\b[^>]*\bname="cargo_code\[\]"[^>]*>/)?.[0];
      return input && /\bvalue="FCL"/.test(input);
    });
    assert.equal(duplicateRows.length, 2, "existing and new duplicate FCL rows are both visible");
    const existingCodeInput = duplicateRows[0].match(/<input\b[^>]*\bname="cargo_code\[\]"[^>]*>/)[0];
    const newCodeInput = duplicateRows[1].match(/<input\b[^>]*\bname="cargo_code\[\]"[^>]*>/)[0];
    assert.match(existingCodeInput, /\breadonly\b/, "existing FCL identifier remains protected");
    assert.doesNotMatch(duplicateRows[0], /\bdata-cargo-remove\b/, "existing FCL row cannot be removed as new");
    assert.doesNotMatch(newCodeInput, /\breadonly\b/, "new duplicate FCL identifier remains editable");
    assert.match(duplicateRows[1], /<button\b[^>]*\bdata-cargo-remove\b/, "new duplicate row remains removable after rejection");
    ok("duplicate validation retains one protected existing row and one editable/removable new row");

    const beforeBlankName = diskContents();
    const blankDefaultName = await request("/admin/quote/settings", {
      method: "POST",
      form: cargoForm(expectedEntries.map((entry) => entry.code === "FCL" ? { ...entry, label: "   " } : entry), { hd_cargoType: "FCL" }),
    });
    assert.equal(blankDefaultName.status, 400, "whitespace default name is rejected");
    assert.equal(diskContents(), beforeBlankName, "blank default name rejection does not alter stored data");
    const returnedDefault = selectOptions(blankDefaultName.html, "hd_cargoType").find((option) => option.selected);
    assert.equal(returnedDefault?.value, "FCL", "rejected rename retains the submitted default selection");
    assert.equal(returnedDefault.label, "FCL", "error editor uses the stable code while its display name is blank");
    const correctedQuote = await saveCargo(expectedEntries, { hd_cargoType: returnedDefault.value });
    assert.equal(correctedQuote.settings.headerDefaults.cargoType, "FCL", "correcting the name preserves the returned default on save");
    assert.deepEqual(correctedQuote.settings.cargoTypes, expectedEntries);
    assert.deepEqual(correctedQuote.settings.headerDefaults, defaultsBefore);
    ok("whitespace-name rejection preserves the default through error rendering and corrected save");

    quote = await readQuote();
    const beforePartial = structuredClone(quote);
    const partial = await request("/admin/quote/settings", { method: "POST", form: { quoteNumberPrefix: "CARGO-PARTIAL-" } });
    assert.equal(partial.status, 302);
    quote = await readQuote();
    assert.deepEqual(quote.settings.cargoTypes, beforePartial.settings.cargoTypes, "omitting presence marker preserves cargo list");
    assert.deepEqual(quote.settings.headerDefaults, beforePartial.settings.headerDefaults);
    assert.deepEqual(quote.notes, beforePartial.notes);
    assert.equal(quote.settings.quoteNumberPrefix, "CARGO-PARTIAL-");
    ok("legacy partial settings submission preserves cargo list, defaults and notes");

    const renamedEntries = expectedEntries.map((entry) => entry.code === customCode ? { ...entry, label: renamedLabel } : entry);
    quote = await saveCargo(renamedEntries, { hd_cargoType: customCode });
    assert.equal(quote.settings.headerDefaults.cargoType, customCode);
    assert.equal((await frontOptions()).find((option) => option.value === customCode)?.label, renamedLabel);
    assert.equal(quote.drafts.find((draft) => draft.number === "CARGO-CUSTOM").header.cargoTypeLabel, customLabel);
    assert.equal((await saveDraft("CARGO-RENAMED", customCode)).header.cargoTypeLabel, renamedLabel);
    const disabledEntries = renamedEntries.map((entry) => entry.code === customCode ? { ...entry, enabled: false } : entry);
    quote = await saveCargo(disabledEntries);
    assert.equal(quote.settings.headerDefaults.cargoType, "", "disabling default clears it");
    assert.equal(quote.drafts.find((draft) => draft.number === "CARGO-CUSTOM").header.cargoType, customCode);
    assert.equal(quote.drafts.find((draft) => draft.number === "CARGO-LEGACY").header.cargoType, "LEGACY-RETIRED");
    assert.deepEqual((await frontOptions()).filter((option) => option.value).map((option) => option.value), ["FCL"]);
    quote = await saveCargo(disabledEntries, { hd_cargoType: customCode });
    assert.equal(quote.settings.headerDefaults.cargoType, "", "crafted disabled default is rejected");
    ok("rename/disable updates choices, clears invalid defaults, and preserves historical draft code/name snapshots");

    const shippingData = await getShippingData();
    const view = assembleQuoteView(quote, { ...buildQuoteFormData(quote), header: customDraft.header }, shippingData);
    const documentHtml = await renderQuoteHtml(view);
    assert.ok(documentHtml.includes(`<td>${escapeXML(customLabel)}</td>`), "PDF HTML uses saved display-name snapshot");
    assert.ok(!documentHtml.includes(customLabel), "PDF HTML escapes saved label");
    const legacyHtml = await renderQuoteHtml({ ...view, header: { ...view.header, cargoType: "LEGACY-RETIRED", cargoTypeLabel: "" } });
    assert.ok(legacyHtml.includes("<td>LEGACY-RETIRED</td>"), "legacy PDF HTML falls back to saved code");
    ok("actual PDF template renders escaped snapshot label and legacy code fallback");

    const allDisabled = renamedEntries.map((entry) => ({ ...entry, enabled: false }));
    quote = await saveCargo(allDisabled, { hd_cargoType: "FCL" });
    assert.deepEqual(quote.settings.cargoTypes, allDisabled);
    assert.equal(quote.settings.headerDefaults.cargoType, "");
    assert.deepEqual((await frontOptions()).filter((option) => option.value), []);
    assert.deepEqual((await readQuote()).settings.cargoTypes, allDisabled, "reload does not reseed disabled list");
    quote = await saveCargo([]);
    assert.deepEqual(quote.settings.cargoTypes, []);
    assert.deepEqual((await frontOptions()).filter((option) => option.value), []);
    assert.deepEqual((await readQuote()).settings.cargoTypes, [], "reload does not reseed explicit empty list");
    assert.equal((await saveDraft("CARGO-EMPTY-LIST", "FCL")).header.cargoType, "");
    ok("all-disabled and explicitly empty lists stay empty across save/reload and reject old codes");

    const persisted = await getShippingData();
    for (const cargoTypes of [renamedEntries, allDisabled, []]) {
      const candidate = structuredClone(persisted);
      candidate.modules.quote.settings.cargoTypes = cargoTypes;
      const normalized = normalizeShippingData(candidate);
      const tables = decompose(normalized);
      const roundtrip = normalizeShippingData(assemble(tables));
      assert.deepEqual(roundtrip.modules.quote.settings.cargoTypes, cargoTypes);
      assert.deepEqual(roundtrip.modules.quote.drafts, normalized.modules.quote.drafts);
      assert.deepEqual(decompose(roundtrip), tables, "normalized decompose/assemble/decompose has no table drift");
    }
    ok("relational map roundtrip preserves configured/disabled/empty lists and complete draft headers");

    console.log(`\naudit-quote-cargo-types-test: ${passed}/${passed} passed`);
    console.log("audit-quote-cargo-types-test-ok");
  } finally {
    if (server) {
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    sessionStore.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
