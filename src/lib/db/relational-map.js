// Pure blob <-> relational mapping for the migration (no DB access).
//
//   decompose(normalized) -> { tableName: [rows] }   (forward: blob -> tables)
//   assemble({ tableName: [rows] }) -> shipping-data shape  (reverse: tables -> blob)
//
// Round-trip contract (verified by the parity gate):
//   normalizeShippingData(assemble(decompose(blob))) === normalizeShippingData(blob)
// assemble does NOT need to reproduce exact key order or derived fields — its
// output is always re-run through normalizeShippingData (idempotent), which
// canonicalises order and rebuilds derived fields (container rateGroupKeys,
// terminal storageRulesByContainer, customs container types, etc.). So assemble
// only has to preserve the *input* fields the normalizer reads.

// Handover shippingLine fields the normalizer sets explicitly (always present);
// everything else on a line (id/name are promoted to columns; active, invoiceNote
// and any unknown spread field) goes to carriers.extra for exact reconstruction.
const CARRIER_HANDLED = new Set([
  "id",
  "name",
  "notes",
  "invoiceToConsigneeOnly",
  "demurrageCutoffHandledBy",
  "containerGroups",
  "localCharges",
  "guarantee",
  "terminalMix",
  "demurrage",
  "quoteDefaults",
]);

const APP_META_KEY = "__app__"; // module_settings row holding top-level generatedFrom

// ---- decompose: normalized blob -> table row arrays ------------------------
function decompose(normalized) {
  const tables = emptyTables();
  const modules = normalized.modules || {};
  const handover = modules.handover || {};
  const customs = modules.customs || {};
  const inland = modules.inland || {};
  const quote = modules.quote || {};

  // exchange_rates (singleton)
  const er = normalized.exchangeRates || {};
  tables.exchange_rates.push({
    id: 1,
    provider: er.provider ?? null,
    docs_url: er.docsUrl ?? null,
    as_of_date: er.asOfDate ?? null,
    last_checked_at: er.lastCheckedAt ?? null,
    last_error: er.lastError ?? null,
    default_quote_currency: er.defaultQuoteCurrency ?? "MXN",
    pairs: er.pairs ?? [],
  });

  // customs mirror note + active by carrier id (Q4: customs-side note preserved)
  const customsNoteById = new Map();
  for (const mirror of customs.shippingLines || []) {
    customsNoteById.set(mirror.id, mirror.notes ?? null);
  }

  // carriers + carrier_local_charges (handover lines are authoritative)
  (handover.shippingLines || []).forEach((line, idx) => {
    const notes = line.notes && typeof line.notes === "object" ? line.notes : {};
    const extra = {};
    for (const key of Object.keys(line)) {
      if (!CARRIER_HANDLED.has(key)) {
        extra[key] = line[key];
      }
    }
    tables.carriers.push({
      id: line.id,
      name: line.name ?? null,
      code: notes.code ?? null,
      rfc: notes.rfc ?? null,
      notes_extra: notes,
      customs_note: customsNoteById.has(line.id) ? customsNoteById.get(line.id) : null,
      active: line.active !== false,
      invoice_to_consignee_only: Boolean(line.invoiceToConsigneeOnly),
      demurrage_cutoff_handled_by: line.demurrageCutoffHandledBy ?? null,
      sort_order: idx,
      container_groups: line.containerGroups ?? [],
      demurrage: line.demurrage ?? {},
      guarantee: line.guarantee ?? {},
      terminal_mix: line.terminalMix ?? [],
      quote_defaults: line.quoteDefaults ?? {},
      extra,
    });
    (line.localCharges || []).forEach((charge, ci) => {
      tables.carrier_local_charges.push({
        id: charge.id,
        carrier_id: line.id,
        concept: charge.concept ?? null,
        note: charge.note ?? null,
        tax_rate: charge.taxRate ?? 0,
        group_rates: charge.groupRates ?? {},
        bl_rate: charge.blRate ?? null,
        sort_order: ci,
      });
    });
  });

  // container_types (handover master; rateGroupKeys/coverage are derived)
  (handover.containerTypes || []).forEach((type, idx) => {
    tables.container_types.push({
      key: type.key,
      label: type.label ?? null,
      rate_group: type.rateGroup ?? null,
      sort_order: idx,
    });
  });

  // customs ports / terminals (+ charges) / yards (+ charges) + join tables
  (customs.ports || []).forEach((port, pIdx) => {
    tables.customs_ports.push({
      id: port.id,
      name: port.name ?? null,
      note: port.note ?? null,
      sort_order: pIdx,
    });
    (port.terminals || []).forEach((terminal, tIdx) => {
      tables.customs_terminals.push({
        id: terminal.id,
        port_id: port.id,
        name: terminal.name ?? null,
        note: terminal.note ?? null,
        sort_order: tIdx,
        storage_config: {
          storageRulesByContainer: terminal.storageRulesByContainer ?? {},
          storageRuleSets: terminal.storageRuleSets ?? [],
          storageAssignmentsByContainerType: terminal.storageAssignmentsByContainerType ?? {},
          storageAssignmentsByLineContainer: terminal.storageAssignmentsByLineContainer ?? {},
          storageUnassignedLineContainers: terminal.storageUnassignedLineContainers ?? [],
        },
      });
      (terminal.fixedCharges || []).forEach((charge, ci) => {
        tables.terminal_charges.push(customsChargeRow(charge, "terminal_id", terminal.id, ci));
      });
    });
  });
  (customs.yards || []).forEach((yard, yIdx) => {
    tables.customs_yards.push({
      id: yard.id,
      name: yard.name ?? null,
      note: yard.note ?? null,
      sort_order: yIdx,
    });
    (yard.dropoffCharges || []).forEach((charge, ci) => {
      tables.yard_charges.push({ ...customsChargeRow(charge, "yard_id", yard.id, ci), kind: "dropoff" });
    });
    (yard.customsCharges || []).forEach((charge, ci) => {
      tables.yard_charges.push({ ...customsChargeRow(charge, "yard_id", yard.id, ci), kind: "customs" });
    });
    (yard.portIds || []).forEach((portId, pi) => {
      tables.yard_ports.push({ yard_id: yard.id, port_id: portId, seq: pi });
    });
    (yard.shippingLineIds || []).forEach((carrierId, si) => {
      tables.yard_carriers.push({ yard_id: yard.id, carrier_id: carrierId, seq: si });
    });
  });

  // inland origins / destinations / rate entries / route cache
  (inland.origins || []).forEach((origin, idx) => {
    tables.inland_origins.push({
      id: origin.id,
      name: origin.name ?? null,
      lat: origin.lat ?? null,
      lng: origin.lng ?? null,
      sort_order: idx,
    });
  });
  (inland.destinations || []).forEach((dest, idx) => {
    tables.inland_destinations.push({
      id: dest.id,
      name: dest.name ?? null,
      name_zh: dest.nameZh ?? null,
      name_es: dest.nameEs ?? null,
      state: dest.state ?? null,
      lat: dest.lat ?? null,
      lng: dest.lng ?? null,
      coord_source: dest.coordSource ?? null,
      needs_review: Boolean(dest.needsReview),
      image_urls: dest.imageUrls ?? [],
      precise_points: dest.precisePoints ?? [],
      enabled: dest.enabled !== false,
      note: dest.note ?? null,
      sort_order: idx,
    });
  });
  (inland.rateEntries || []).forEach((entry, idx) => {
    tables.inland_rate_entries.push({
      id: entry.id,
      sort_order: idx,
      origin_id: entry.originId ?? null,
      destination_id: entry.destinationId ?? null,
      proveedor: entry.proveedor ?? null,
      dup_index: entry.dupIndex ?? 1,
      cliente: entry.cliente ?? null,
      codigo_cw: entry.codigoCw ?? null,
      commodity: entry.commodity ?? null,
      sencillo: entry.sencillo ?? null,
      full: entry.full ?? null,
      burreo: entry.burreo ?? null,
      vehicle_prices: entry.vehiclePrices ?? {},
      currency: entry.currency ?? "MXN",
      enabled: entry.enabled !== false,
      note: entry.note ?? null,
      extras: entry.extras ?? {},
    });
  });
  (inland.routeCache || []).forEach((rc, idx) => {
    tables.inland_route_cache.push({
      id: rc.id,
      sort_order: idx,
      origin_id: rc.originId ?? null,
      destination_id: rc.destinationId ?? null,
      target_type: rc.targetType ?? "destination",
      target_id: rc.targetId ?? null,
      encoded_polyline: rc.encodedPolyline ?? null,
      distance_km: rc.distanceKm ?? null,
      duration_min: rc.durationMin ?? null,
      via_cities: rc.viaCities ?? [],
      engine: rc.engine ?? null,
      fetched_at: rc.fetchedAt ?? null,
      stale: Boolean(rc.stale),
      has_ferry: Boolean(rc.hasFerry),
      manual_override: rc.manualOverride ?? null,
    });
  });

  // quote drafts + notes
  (quote.drafts || []).forEach((draft, idx) => {
    tables.quote_drafts.push({
      id: draft.id,
      sort_order: idx,
      number: draft.number ?? null,
      date: draft.date ?? null,
      header: draft.header ?? {},
      quote_mode: draft.quoteMode ?? null,
      line_items: draft.lineItems ?? [],
      note_ids: draft.noteIds ?? [],
      language: draft.language ?? null,
      created_at: draft.createdAt ?? null,
      updated_at: draft.updatedAt ?? null,
    });
  });
  (quote.notes || []).forEach((note, idx) => {
    tables.quote_notes.push({
      id: note.id,
      en: note.en ?? null,
      es: note.es ?? null,
      zh: note.zh ?? null,
      sort_order: idx,
    });
  });

  // module_settings (one row per module) + top-level generatedFrom
  for (const key of ["handover", "customs", "inland", "quote"]) {
    const mod = modules[key];
    if (!mod) {
      continue;
    }
    tables.module_settings.push({
      module_key: key,
      settings: mod.settings ?? {},
      tax_rate_presets: mod.taxRatePresets ?? [],
    });
  }
  tables.module_settings.push({
    module_key: APP_META_KEY,
    settings: { generatedFrom: normalized.generatedFrom ?? null },
    tax_rate_presets: [],
  });

  return tables;
}

function customsChargeRow(charge, fkName, fkValue, idx) {
  return {
    id: charge.id,
    [fkName]: fkValue,
    concept: charge.concept ?? null,
    note: charge.note ?? null,
    tax_rate: charge.taxRate ?? 0,
    group_rates: charge.groupRates ?? {},
    basis: charge.basis === "per_day" ? "per_day" : "per_occurrence",
    required: Boolean(charge.required),
    amount: charge.amount ?? null,
    amount_currency: charge.amountCurrency ?? "MXN",
    sort_order: idx,
  };
}

// ---- assemble: table rows -> shipping-data shape (pre-normalize) -----------
function assemble(tables) {
  const t = { ...emptyTables(), ...tables };
  const settingsByModule = new Map();
  let generatedFrom = null;
  for (const row of t.module_settings) {
    if (row.module_key === APP_META_KEY) {
      generatedFrom = (row.settings || {}).generatedFrom ?? null;
    } else {
      settingsByModule.set(row.module_key, row);
    }
  }
  const moduleShell = (key) => {
    const row = settingsByModule.get(key) || {};
    return { settings: row.settings || {}, taxRatePresets: row.tax_rate_presets || [] };
  };

  // exchange_rates
  const erRow = t.exchange_rates[0] || {};
  const exchangeRates = {
    provider: erRow.provider ?? undefined,
    docsUrl: erRow.docs_url ?? undefined,
    asOfDate: erRow.as_of_date ?? null,
    lastCheckedAt: erRow.last_checked_at ?? null,
    lastError: erRow.last_error ?? null,
    defaultQuoteCurrency: erRow.default_quote_currency ?? "MXN",
    pairs: erRow.pairs ?? [],
  };

  // carriers -> handover shippingLines
  const chargesByCarrier = groupBy(t.carrier_local_charges, "carrier_id");
  const handoverLines = sortBySortOrder(t.carriers).map((row) => {
    const localCharges = sortBySortOrder(chargesByCarrier.get(row.id) || []).map((ch) => ({
      id: ch.id,
      concept: ch.concept ?? undefined,
      note: ch.note ?? null,
      taxRate: numOrNull(ch.tax_rate),
      groupRates: ch.group_rates ?? {},
      blRate: ch.bl_rate ?? null,
    }));
    return {
      ...(row.extra || {}),
      id: row.id,
      name: row.name ?? undefined,
      notes: row.notes_extra ?? {},
      invoiceToConsigneeOnly: row.invoice_to_consignee_only,
      demurrageCutoffHandledBy: row.demurrage_cutoff_handled_by ?? undefined,
      containerGroups: row.container_groups ?? [],
      guarantee: row.guarantee ?? {},
      demurrage: row.demurrage ?? {},
      terminalMix: row.terminal_mix ?? [],
      quoteDefaults: row.quote_defaults ?? {},
      localCharges,
    };
  });

  // container types (handover master)
  const containerTypes = sortBySortOrder(t.container_types).map((row) => ({
    key: row.key,
    label: row.label ?? undefined,
    rateGroup: row.rate_group ?? undefined,
  }));

  // customs ports / terminals / yards
  const chargesByTerminal = groupBy(t.terminal_charges, "terminal_id");
  const terminalsByPort = groupBy(t.customs_terminals, "port_id");
  const ports = sortBySortOrder(t.customs_ports).map((port) => ({
    id: port.id,
    name: port.name ?? undefined,
    note: port.note ?? null,
    terminals: sortBySortOrder(terminalsByPort.get(port.id) || []).map((term) => {
      const sc = term.storage_config || {};
      return {
        id: term.id,
        name: term.name ?? undefined,
        note: term.note ?? null,
        fixedCharges: sortBySortOrder(chargesByTerminal.get(term.id) || []).map(chargeFromRow),
        storageRulesByContainer: sc.storageRulesByContainer ?? {},
        storageRuleSets: sc.storageRuleSets ?? [],
        storageAssignmentsByContainerType: sc.storageAssignmentsByContainerType ?? {},
        storageAssignmentsByLineContainer: sc.storageAssignmentsByLineContainer ?? {},
        storageUnassignedLineContainers: sc.storageUnassignedLineContainers ?? [],
      };
    }),
  }));

  const yardChargesByYard = groupBy(t.yard_charges, "yard_id");
  const portIdsByYard = groupBy(t.yard_ports, "yard_id");
  const carrierIdsByYard = groupBy(t.yard_carriers, "yard_id");
  const yards = sortBySortOrder(t.customs_yards).map((yard) => {
    const yardCharges = sortBySortOrder(yardChargesByYard.get(yard.id) || []);
    return {
      id: yard.id,
      name: yard.name ?? undefined,
      note: yard.note ?? null,
      portIds: bySeq(portIdsByYard.get(yard.id)).map((r) => r.port_id),
      shippingLineIds: bySeq(carrierIdsByYard.get(yard.id)).map((r) => r.carrier_id),
      dropoffCharges: yardCharges.filter((c) => c.kind === "dropoff").map(chargeFromRow),
      customsCharges: yardCharges.filter((c) => c.kind === "customs").map(chargeFromRow),
    };
  });

  // customs mirror shippingLines (id/name/active from carrier, notes = customs_note,
  // yardIds = reverse of yard_carriers). The normalizer re-derives the rest.
  const yardIdsByCarrier = groupBy(t.yard_carriers, "carrier_id");
  const customsMirror = sortBySortOrder(t.carriers).map((row) => ({
    id: row.id,
    name: row.name ?? undefined,
    active: row.active,
    notes: row.customs_note ?? null,
    yardIds: bySeq(yardIdsByCarrier.get(row.id)).map((r) => r.yard_id),
  }));

  // inland
  const origins = sortBySortOrder(t.inland_origins).map((row) => ({
    id: row.id,
    name: row.name ?? undefined,
    lat: numOrNull(row.lat),
    lng: numOrNull(row.lng),
  }));
  const destinations = sortBySortOrder(t.inland_destinations).map((row) => ({
    id: row.id,
    name: row.name ?? undefined,
    nameZh: row.name_zh ?? undefined,
    nameEs: row.name_es ?? undefined,
    state: row.state ?? undefined,
    imageUrls: row.image_urls ?? [],
    lat: numOrNull(row.lat),
    lng: numOrNull(row.lng),
    coordSource: row.coord_source ?? undefined,
    needsReview: row.needs_review,
    precisePoints: row.precise_points ?? [],
    enabled: row.enabled,
    note: row.note ?? undefined,
  }));
  const rateEntries = sortBySortOrder(t.inland_rate_entries).map((row) => ({
    id: row.id,
    originId: row.origin_id ?? undefined,
    destinationId: row.destination_id ?? undefined,
    proveedor: row.proveedor ?? undefined,
    dupIndex: row.dup_index ?? 1,
    sencillo: numOrNull(row.sencillo),
    full: numOrNull(row.full),
    burreo: row.burreo ?? null,
    vehiclePrices: row.vehicle_prices ?? {},
    currency: row.currency ?? "MXN",
    cliente: row.cliente ?? undefined,
    codigoCw: row.codigo_cw ?? undefined,
    commodity: row.commodity ?? undefined,
    enabled: row.enabled,
    note: row.note ?? undefined,
    extras: row.extras ?? {},
  }));
  const routeCache = sortBySortOrder(t.inland_route_cache).map((row) => ({
    id: row.id,
    originId: row.origin_id ?? undefined,
    destinationId: row.destination_id ?? undefined,
    targetType: row.target_type ?? "destination",
    targetId: row.target_id ?? null,
    encodedPolyline: row.encoded_polyline ?? "",
    distanceKm: numOrNull(row.distance_km),
    durationMin: numOrNull(row.duration_min),
    viaCities: row.via_cities ?? [],
    engine: row.engine ?? undefined,
    fetchedAt: row.fetched_at ?? null,
    stale: row.stale,
    hasFerry: row.has_ferry,
    manualOverride: row.manual_override ?? null,
  }));

  // quote
  const drafts = sortBySortOrder(t.quote_drafts).map((row) => ({
    id: row.id,
    number: row.number ?? undefined,
    date: row.date ?? undefined,
    header: row.header ?? {},
    quoteMode: row.quote_mode ?? undefined,
    lineItems: row.line_items ?? [],
    noteIds: row.note_ids ?? [],
    language: row.language ?? undefined,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }));
  const notes = sortBySortOrder(t.quote_notes).map((row) => ({
    id: row.id,
    en: row.en ?? undefined,
    es: row.es ?? undefined,
    zh: row.zh ?? undefined,
  }));

  const handoverShell = moduleShell("handover");
  const customsShell = moduleShell("customs");
  const inlandShell = moduleShell("inland");
  const quoteShell = moduleShell("quote");

  return {
    generatedFrom,
    exchangeRates,
    modules: {
      handover: { ...handoverShell, shippingLines: handoverLines, containerTypes },
      customs: {
        ...customsShell,
        shippingLines: customsMirror,
        containerTypes,
        ports,
        yards,
      },
      inland: { ...inlandShell, origins, destinations, rateEntries, routeCache },
      // templateRows omitted on purpose (Q3: seeded from code constants); the
      // normalizer re-seeds them. The parity gate fails loudly if a store's
      // templateRows ever diverge from the constants.
      quote: { ...quoteShell, notes, drafts },
    },
  };
}

function chargeFromRow(row) {
  return {
    id: row.id,
    concept: row.concept ?? undefined,
    note: row.note ?? null,
    taxRate: numOrNull(row.tax_rate),
    groupRates: row.group_rates ?? {},
    basis: row.basis ?? undefined,
    required: row.required,
    amount: numOrNull(row.amount),
    amountCurrency: row.amount_currency ?? undefined,
  };
}

// ---- table metadata (column lists, JSONB columns, insert order) -----------
// SCHEMA TRUTH — this is the LOGICAL projection of the schema (column NAME list + jsonb
// flags + PK). It MUST stay in sync with the PHYSICAL DDL in ./relational-repo.js
// (buildSchemaDDL): every column here must exist there with a compatible type, and every
// jsonb column there must be flagged here. Editing one without the other silently drops a
// column from upsert/read. The round-trip + parity gates are the drift guard. See the
// "SCHEMA TRUTH — TWO VIEWS, ONE SCHEMA" note above buildSchemaDDL.
const TABLE_META = {
  exchange_rates: {
    pk: ["id"],
    cols: ["id", "provider", "docs_url", "as_of_date", "last_checked_at", "last_error", "default_quote_currency", "pairs"],
    jsonb: ["pairs"],
  },
  carriers: {
    pk: ["id"],
    cols: ["id", "name", "code", "rfc", "notes_extra", "customs_note", "active", "invoice_to_consignee_only", "demurrage_cutoff_handled_by", "sort_order", "container_groups", "demurrage", "guarantee", "terminal_mix", "quote_defaults", "extra"],
    jsonb: ["notes_extra", "customs_note", "container_groups", "demurrage", "guarantee", "terminal_mix", "quote_defaults", "extra"],
  },
  carrier_local_charges: {
    pk: ["id"],
    cols: ["id", "carrier_id", "concept", "note", "tax_rate", "group_rates", "bl_rate", "sort_order"],
    jsonb: ["group_rates", "bl_rate"],
  },
  container_types: {
    pk: ["key"],
    cols: ["key", "label", "rate_group", "sort_order"],
    jsonb: [],
  },
  customs_ports: {
    pk: ["id"],
    cols: ["id", "name", "note", "sort_order"],
    jsonb: [],
  },
  customs_terminals: {
    pk: ["id"],
    cols: ["id", "port_id", "name", "note", "sort_order", "storage_config"],
    jsonb: ["storage_config"],
  },
  terminal_charges: {
    pk: ["id"],
    cols: ["id", "terminal_id", "concept", "note", "tax_rate", "group_rates", "basis", "required", "amount", "amount_currency", "sort_order"],
    jsonb: ["group_rates"],
  },
  customs_yards: {
    pk: ["id"],
    cols: ["id", "name", "note", "sort_order"],
    jsonb: [],
  },
  yard_charges: {
    pk: ["id"],
    cols: ["id", "yard_id", "kind", "concept", "note", "tax_rate", "group_rates", "basis", "required", "amount", "amount_currency", "sort_order"],
    jsonb: ["group_rates"],
  },
  yard_ports: { pk: ["yard_id", "port_id"], cols: ["yard_id", "port_id", "seq"], jsonb: [] },
  yard_carriers: { pk: ["yard_id", "carrier_id"], cols: ["yard_id", "carrier_id", "seq"], jsonb: [] },
  inland_origins: { pk: ["id"], cols: ["id", "name", "lat", "lng", "sort_order"], jsonb: [] },
  inland_destinations: {
    pk: ["id"],
    cols: ["id", "name", "name_zh", "name_es", "state", "lat", "lng", "coord_source", "needs_review", "image_urls", "precise_points", "enabled", "note", "sort_order"],
    jsonb: ["image_urls", "precise_points"],
  },
  inland_rate_entries: {
    pk: ["id"],
    cols: ["id", "origin_id", "destination_id", "proveedor", "dup_index", "cliente", "codigo_cw", "commodity", "sencillo", "full", "burreo", "vehicle_prices", "currency", "enabled", "note", "extras", "sort_order"],
    jsonb: ["burreo", "vehicle_prices", "extras"],
  },
  inland_route_cache: {
    pk: ["id"],
    cols: ["id", "origin_id", "destination_id", "target_type", "target_id", "encoded_polyline", "distance_km", "duration_min", "via_cities", "engine", "fetched_at", "stale", "has_ferry", "manual_override", "sort_order"],
    jsonb: ["via_cities", "manual_override"],
  },
  quote_drafts: {
    pk: ["id"],
    cols: ["id", "number", "date", "header", "quote_mode", "line_items", "note_ids", "language", "created_at", "updated_at", "sort_order"],
    jsonb: ["header", "line_items", "note_ids"],
  },
  quote_notes: { pk: ["id"], cols: ["id", "en", "es", "zh", "sort_order"], jsonb: [] },
  module_settings: {
    pk: ["module_key"],
    cols: ["module_key", "settings", "tax_rate_presets"],
    jsonb: ["settings", "tax_rate_presets"],
  },
};

// Parent-before-child order for inserts / FK safety.
const INSERT_ORDER = [
  "exchange_rates",
  "carriers",
  "carrier_local_charges",
  "container_types",
  "customs_ports",
  "customs_terminals",
  "terminal_charges",
  "customs_yards",
  "yard_charges",
  "yard_ports",
  "yard_carriers",
  "inland_origins",
  "inland_destinations",
  "inland_rate_entries",
  "inland_route_cache",
  "quote_drafts",
  "quote_notes",
  "module_settings",
];

// ---- helpers ---------------------------------------------------------------
function emptyTables() {
  const out = {};
  for (const name of INSERT_ORDER) {
    out[name] = [];
  }
  return out;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    const k = row[key];
    if (!map.has(k)) {
      map.set(k, []);
    }
    map.get(k).push(row);
  }
  return map;
}

function sortBySortOrder(rows) {
  return [...(rows || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

// Join-table rows carry `seq` (not sort_order) for within-parent order.
function bySeq(rows) {
  return [...(rows || [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

// pg returns numeric columns as strings; coerce back to number (null stays null).
function numOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = { decompose, assemble, TABLE_META, INSERT_ORDER, APP_META_KEY };
