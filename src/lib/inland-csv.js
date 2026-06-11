// Pure CSV cleaning for the inland tariff (TARIFARIO_TERRESTRES_..._2026_.csv).
// Kept separate from the seed script so it can be unit-tested with synthetic
// fixtures. Input is a decoded string (the script decodes Latin-1 first).

const { resolveDestinoIds, normalizeDestinoKey } = require("./inland-catalog");

const DEFAULT_INLAND_ORIGIN_ID = "manzanillo";

// Known CSV headers -> rate-entry fields (header normalized: upper, accent-free,
// collapsed whitespace). Everything else (except VIGENCIA) goes into `extras`.
const FIELD_BY_HEADER = {
  ORIGEN: "origin",
  DESTINO: "destino",
  PROVEEDOR: "proveedor",
  SENCILLO: "sencillo",
  FULL: "full",
  CONSIGNATARIO: "cliente",
  "CODIGO CW": "codigoCw",
  COMODITY: "commodity",
  COMMODITY: "commodity",
  VIGENCIA: "__drop__",
};

function normalizeHeader(header) {
  return String(header || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

// " $72,000.00 " -> 72000 ; empty / non-numeric -> null.
function parseAmount(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  const cleaned = String(raw).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "." || cleaned === "-.") {
    return null;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

// Spanish/Excel exports often use ';' because ',' is the thousands separator in
// amounts like "$72,000.00". Detect the delimiter from the header line.
function detectDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/)[0] || "";
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  if (tabs > semicolons && tabs > commas) {
    return "\t";
  }
  return semicolons > commas ? ";" : ",";
}

// Minimal RFC-4180-ish parser: handles quoted fields, embedded delimiters,
// escaped quotes ("") and CRLF/CR newlines. Returns array of cell arrays
// (incl. header). Delimiter is auto-detected unless provided.
function parseCsvRows(text, delimiter) {
  const source = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const sep = delimiter || detectDelimiter(source);
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === sep) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ""));
}

function buildRateEntryId(originId, destinationId, proveedor, cliente, commodity) {
  const key = [originId, destinationId, proveedor, cliente, commodity].join("|");
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `re-${destinationId}-${hash.toString(36)}`;
}

// Clean a decoded CSV string into normalized rate entries + a cleaning report.
function cleanInlandCsv(text) {
  const rows = parseCsvRows(text);
  const report = {
    totalRows: 0,
    totalEntries: 0,
    splitRows: [],
    nullFullRows: 0,
    unmappedDestinos: [],
    touchedDestinations: new Set(),
  };
  const rateEntries = [];
  if (!rows.length) {
    report.touchedDestinations = [];
    return { rateEntries, report };
  }

  const headers = rows[0].map((header) => normalizeHeader(header));
  const unmappedSeen = new Set();

  for (const cells of rows.slice(1)) {
    report.totalRows += 1;
    const known = {};
    const extras = {};
    headers.forEach((header, index) => {
      const value = (cells[index] ?? "").toString().trim();
      const field = FIELD_BY_HEADER[header];
      if (field === "__drop__" || header === "") {
        return;
      }
      if (field) {
        known[field] = value;
      } else {
        extras[header] = value;
      }
    });

    // ORIGEN typo fix; all rows currently map to the manzanillo origin.
    const originRaw = normalizeHeader(known.origin || "");
    if (originRaw && originRaw !== "MANZANILLO" && originRaw !== "MANANILLO") {
      extras.ORIGEN_RAW = known.origin;
    }
    const originId = DEFAULT_INLAND_ORIGIN_ID;

    const destinoRaw = known.destino || "";
    const destinationIds = resolveDestinoIds(destinoRaw);
    if (!destinationIds.length) {
      const key = normalizeDestinoKey(destinoRaw);
      if (key && !unmappedSeen.has(key)) {
        unmappedSeen.add(key);
        report.unmappedDestinos.push(destinoRaw);
      }
      continue;
    }
    if (destinationIds.length > 1) {
      report.splitRows.push({ destino: destinoRaw, ids: destinationIds });
    }

    const sencillo = parseAmount(known.sencillo);
    const full = parseAmount(known.full);

    for (const destinationId of destinationIds) {
      report.touchedDestinations.add(destinationId);
      if (full === null) {
        report.nullFullRows += 1;
      }
      rateEntries.push({
        id: buildRateEntryId(
          originId,
          destinationId,
          known.proveedor || "",
          known.cliente || "",
          known.commodity || ""
        ),
        originId,
        destinationId,
        proveedor: known.proveedor || "",
        sencillo,
        full,
        currency: "MXN",
        cliente: known.cliente || "",
        codigoCw: known.codigoCw || "",
        commodity: known.commodity || "",
        enabled: true,
        note: "",
        extras,
      });
      report.totalEntries += 1;
    }
  }

  report.touchedDestinations = [...report.touchedDestinations];
  return { rateEntries, report };
}

// Idempotent merge by (destinationId, proveedor, cliente, commodity).
// Existing entries keep their id and are updated in place; new ones are appended.
function mergeRateEntries(existing, incoming) {
  const keyOf = (entry) =>
    [
      entry.destinationId,
      String(entry.proveedor || "").toLowerCase(),
      String(entry.cliente || "").toLowerCase(),
      String(entry.commodity || "").toLowerCase(),
    ].join("||");

  const byKey = new Map();
  const entries = (Array.isArray(existing) ? existing : []).map((entry) => ({ ...entry }));
  entries.forEach((entry) => byKey.set(keyOf(entry), entry));

  let added = 0;
  let updated = 0;
  for (const entry of incoming) {
    const key = keyOf(entry);
    const current = byKey.get(key);
    if (current) {
      Object.assign(current, entry, { id: current.id });
      updated += 1;
    } else {
      byKey.set(key, entry);
      entries.push(entry);
      added += 1;
    }
  }
  return { entries, added, updated };
}

module.exports = {
  parseAmount,
  parseCsvRows,
  detectDelimiter,
  cleanInlandCsv,
  mergeRateEntries,
  normalizeHeader,
};
