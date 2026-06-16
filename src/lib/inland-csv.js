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

// Decode a CSV file Buffer with encoding auto-detection: strict UTF-8 first
// (so a UTF-8/CP1252 re-export from Excel is read correctly), falling back to
// Latin-1 (ISO-8859-1) when the bytes are not valid UTF-8. Strips a UTF-8 BOM.
function decodeCsvBuffer(buffer) {
  let bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_error) {
    text = bytes.toString("latin1");
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text;
}

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

// Parse a "SENCILLO $4800 FULL $7800" style cell into { sencillo, full }. Either
// side may be missing (that key becomes null). No SENCILLO/FULL amounts at all
// -> null, so callers can treat "no burreo" and "0 burreo" distinctly.
function parseSencilloFull(raw) {
  const text = String(raw == null ? "" : raw);
  if (!text.trim()) {
    return null;
  }
  const sMatch = text.match(/SENCILLO\s*\$?\s*([\d.,]+)/i);
  const fMatch = text.match(/FULL\s*\$?\s*([\d.,]+)/i);
  const sencillo = sMatch ? parseAmount(sMatch[1]) : null;
  const full = fMatch ? parseAmount(fMatch[1]) : null;
  if (sencillo === null && full === null) {
    return null;
  }
  return { sencillo, full };
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

// dupIndex disambiguates rows that are identical on the base identity columns
// (destinationId, proveedor, cliente, commodity) but differ only in price — so
// such rows get distinct ids instead of colliding. size=1 groups use dupIndex=1.
function buildRateEntryId(originId, destinationId, proveedor, cliente, commodity, dupIndex = 1) {
  const key = [originId, destinationId, proveedor, cliente, commodity, dupIndex].join("|");
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `re-${destinationId}-${hash.toString(36)}`;
}

function baseRateEntryKey(entry) {
  return [
    entry.destinationId,
    String(entry.proveedor || "").toLowerCase(),
    String(entry.cliente || "").toLowerCase(),
    String(entry.commodity || "").toLowerCase(),
  ].join("||");
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
    duplicateKeyGroups: [],
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
    // R2 short-haul / drayage ("BURREO / LOCAL"): structured from extras, raw
    // extras value preserved. The header normalizes to "BURREO / LOCAL".
    const burreo = parseSencilloFull(extras["BURREO / LOCAL"]);

    for (const destinationId of destinationIds) {
      report.touchedDestinations.add(destinationId);
      if (full === null) {
        report.nullFullRows += 1;
      }
      rateEntries.push({
        id: "",
        originId,
        destinationId,
        proveedor: known.proveedor || "",
        sencillo,
        full,
        burreo: burreo ? { ...burreo } : null,
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

  // Assign dupIndex per base-key group (in file order) and build the final id.
  // Idempotency: re-seeding the same file yields the same order -> same dupIndex
  // -> same ids -> in-place update. If the file rows are reordered, two entries
  // swap identities but the resulting set is identical, so the end state is
  // still correct.
  const groupRunning = new Map();
  for (const entry of rateEntries) {
    const key = baseRateEntryKey(entry);
    const dupIndex = (groupRunning.get(key) || 0) + 1;
    groupRunning.set(key, dupIndex);
    entry.dupIndex = dupIndex;
    entry.id = buildRateEntryId(
      entry.originId,
      entry.destinationId,
      entry.proveedor,
      entry.cliente,
      entry.commodity,
      dupIndex
    );
  }

  // Report duplicate-key groups (same base key, >1 price tier kept).
  const groups = new Map();
  for (const entry of rateEntries) {
    const key = baseRateEntryKey(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const [, entries] of groups) {
    if (entries.length > 1) {
      report.duplicateKeyGroups.push({
        destinationId: entries[0].destinationId,
        proveedor: entries[0].proveedor,
        cliente: entries[0].cliente,
        commodity: entries[0].commodity,
        count: entries.length,
        tiers: entries.map((e) => ({ sencillo: e.sencillo, full: e.full })),
      });
    }
  }

  report.touchedDestinations = [...report.touchedDestinations];
  return { rateEntries, report };
}

// Idempotent merge by (destinationId, proveedor, cliente, commodity, dupIndex).
// dupIndex (default 1) keeps rows that differ only in price as distinct entries.
// Existing entries keep their id and are updated in place; new ones are appended.
function mergeRateEntries(existing, incoming) {
  const keyOf = (entry) =>
    [baseRateEntryKey(entry), entry.dupIndex || 1].join("##");

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
  parseSencilloFull,
  parseCsvRows,
  detectDelimiter,
  decodeCsvBuffer,
  cleanInlandCsv,
  mergeRateEntries,
  normalizeHeader,
};
