"use strict";

const { generateQuoteNumber } = require("./quote");
const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const TAX_TREATMENTS = ["included", "excluded", "mexico_included"];

function validateQuoteNaming(header = {}) {
  const errors = [];
  for (const field of ["customerCode", "salesCode"]) {
    if (header[field] && (typeof header[field] !== "string" || !CODE.test(header[field]))) errors.push(field);
  }
  if (Boolean(header.customerCode) !== Boolean(header.salesCode)) errors.push("code_pair");
  if (!Number.isInteger(Number(header.revision ?? 1)) || Number(header.revision ?? 1) < 1 || Number(header.revision ?? 1) > 9999) errors.push("revision");
  return errors;
}

function quoteSerial(number, settings = {}) {
  const value = String(number || "quote");
  const prefix = typeof settings.quoteNumberPrefix === "string" ? settings.quoteNumberPrefix : "ELCMEX-SI-";
  const suffix = typeof settings.quoteNumberSuffix === "string" ? settings.quoteNumberSuffix : "E";
  if (value.startsWith(prefix) && (!suffix || value.endsWith(suffix))) {
    const serial = value.slice(prefix.length, suffix ? -suffix.length : undefined);
    if (/^\d+$/.test(serial)) return serial;
  }
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 100) || "quote";
}

function buildQuoteFilename(formData = {}, settings = {}) {
  const header = formData.header || {};
  const legacy = String(formData.number || "quote").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 140) || "quote";
  const named = header.customerCode && header.salesCode && !validateQuoteNaming(header).length;
  const stem = named
    ? `${header.customerCode}-${header.salesCode}-${quoteSerial(formData.number, settings)}-v${String(header.revision ?? 1).padStart(2, "0")}`
    : legacy;
  return `${stem}${header.quoteType === "long_term" ? "-rate-card" : ""}${header.outputAudience === "internal" ? "-internal" : ""}.pdf`;
}

// Save/output identity is separate from the editable quotation number. A fresh
// browser's suggested number is not a reserved sequence. Allocate only inside
// the route mutation lock, after re-reading the current module.
function resolveQuoteNumber(quoteModule, formData, body = {}) {
  const drafts = quoteModule.drafts || [];
  const existing = drafts.find((draft) => draft.id === formData.draftId) ||
    drafts.find((draft) => formData.header.quoteEditorId && draft.header?.quoteEditorId === formData.header.quoteEditorId);
  const provided = typeof body.quotationNumber === "string" ? body.quotationNumber.trim() : "";
  const suggestion = typeof body.quoteNumberSuggestion === "string" ? body.quoteNumberSuggestion.trim() : "";
  let number;
  let advanceTo = null;
  if (existing && (!provided || provided === suggestion || provided === existing.number)) number = existing.number;
  else if (!provided || (suggestion && provided === suggestion)) {
    let generated = generateQuoteNumber(quoteModule.settings);
    const used = new Set(drafts.filter((draft) => draft.id !== existing?.id).map((draft) => draft.number));
    // A manually assigned future serial or legacy counter lag must not wedge
    // automatic issuance. Each skipped candidate is already occupied.
    while (used.has(generated.number)) generated = generateQuoteNumber({ ...quoteModule.settings, lastQuoteSeq: generated.nextSeq });
    number = generated.number;
    advanceTo = generated.nextSeq;
  } else number = provided;
  if (drafts.some((draft) => draft.id !== existing?.id && draft.number === number)) {
    return { error: "duplicate_number" };
  }
  // Legacy clients sometimes post a generated number without its suggestion.
  // Consume that sequence too, rather than allowing the next editor to reuse it.
  if (advanceTo === null && !existing) {
    const generated = generateQuoteNumber(quoteModule.settings);
    if (number === generated.number) advanceTo = generated.nextSeq;
  }
  return { number, advanceTo, existing };
}

// Remove only an incompatible general tax assertion, at sentence granularity.
// Other sentences (insurance, FX, validity) remain in the same business note.
function conflictingTaxSentence(sentence, treatment) {
  const text = sentence.toLowerCase();
  const taxWord = /\bvat\b|\biva\b|tax(?:es)?\b|impuesto|增值税|含税|加税|未税/.test(text);
  if (!taxWord) return false;
  const foreignScope = /\borigin\b|\bforeign\b|\bchina\b|fuera de m[ée]xico|origen|境外|起运|中国|国外/.test(text);
  const mexicoScope = /mexic|m[ée]xico|墨西哥/.test(text);
  if (treatment === "mexico_included" && foreignScope && !mexicoScope) return false;
  // Insurance/freight conditions are not blanket tax policy. In particular,
  // a price that excludes insurance plus a later insurance VAT condition must
  // never disappear just because the two words occur in one saved note.
  const businessCondition = /insurance|insured|seguro|保险|保额/.test(text);
  if (businessCondition) return false;
  const generalPrices = /(?:all|above|these|quoted|entered|our|the)\s+prices|prices\s+(?:are|include|exclude)|上述价格|本报价|所有价格|报价.*(?:含税|加税)|precios|tarifas/.test(text);
  const taxSubject = /^\s*(?:\d+(?:\.\d+)?%\s*)?(?:vat|iva|tax(?:es)?|impuestos|增值税|税费|开票|结算|另加)/.test(text);
  const currencyPrice = /(?:mxn|usd|比索|美金).*(?:price|价|vat|iva|税)/.test(text);
  if (!generalPrices && !taxSubject && !mexicoScope && !currencyPrice) return false;
  const negative = /(?:exclud\w*|exclusive\s+of|not\s+includ\w*|no\s+incluy\w*|sin)\s+(?:(?:applicable|local|mexican|any|all|el|los)\s+)*(?:\d+(?:\.\d+)?%\s*)?(?:vat|iva|tax\w*|impuesto\w*)|(?:vat|iva|tax\w*)\s+(?:is|are)?\s*not\s+included|不含(?:适用的?|墨西哥)?(?:增值)?税|未含(?:增值)?税|未税/.test(text);
  const positiveText = text.replace(/(?:does\s+not|do\s+not|not|no)\s+includ\w*/g, "");
  const positive = /\binclud(?:e|es|ed|ing)\s+(?:(?:applicable|local|mexican|any|all|el|los)\s+)*(?:\d+(?:\.\d+)?%\s*)?(?:vat|iva|tax\w*|impuesto\w*)|\bcon\s+(?:iva|impuesto)|已含(?:适用的?|墨西哥)?(?:增值)?税|包含.*税/.test(positiveText);
  const added = /(?:vat|iva|tax\w*).{0,25}\b(?:added|additional|charged)\b|\b(?:added|additional)\b.{0,25}(?:vat|iva|tax\w*)|另加|另收/.test(text);
  if (treatment === "mexico_included") return negative || added || (positive && !mexicoScope);
  if (treatment === "included") return negative || added;
  return positive;
}

function splitTaxSentences(value) {
  const sentences = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (!".!?。！？;；".includes(char)) continue;
    if (char === "." && /\d/.test(value[index - 1] || "") && /\d/.test(value[index + 1] || "")) continue;
    if (".!?".includes(char) && index + 1 < value.length && !/[\s\u4e00-\u9fff]/.test(value[index + 1])) continue;
    sentences.push(value.slice(start, index + 1));
    start = index + 1;
  }
  if (start < value.length) sentences.push(value.slice(start));
  return sentences;
}

function filterTaxNotes(notes = [], treatment) {
  if (!TAX_TREATMENTS.includes(treatment)) return notes;
  return notes.map((note) => {
    const filtered = { ...note };
    for (const lang of ["en", "zh", "es"]) {
      if (typeof note[lang] !== "string") continue;
      // Split punctuation only at a sentence boundary, preserving 0.25% and
      // retaining the original punctuation in surviving business sentences.
      const sentences = splitTaxSentences(note[lang]);
      filtered[lang] = sentences.filter((sentence) => !conflictingTaxSentence(sentence, treatment)).map((sentence) => sentence.trim()).join(" ");
    }
    return filtered;
  }).filter((note) => [note.en, note.zh, note.es].some((value) => typeof value === "string" && value.trim()));
}

module.exports = { validateQuoteNaming, quoteSerial, buildQuoteFilename, resolveQuoteNumber, filterTaxNotes };
