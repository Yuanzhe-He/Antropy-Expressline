// Relational target schema for the blob→relational migration (subphase 2a).
// DDL is idempotent (create … if not exists) so it can be re-applied safely.
// Mirrors docs/specs/20260621_blob_to_relational_redesign.md §B′ (approved:
// Q1/Q2/Q3 deep structures stay JSONB, Q5 money = numeric(14,4), Q4 adds
// carriers.customs_note). All tables live in the configured schema (default
// `expressline`); project-level isolation is enforced separately by sandbox-guard.
function q(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

// Returns the ordered list of DDL statements (tables before their indexes/FKs).
function buildSchemaDDL(schemaName) {
  const s = q(schemaName);
  return [
    `create schema if not exists ${s}`,

    // B′.1 exchange_rates (singleton hot row)
    `create table if not exists ${s}.exchange_rates (
       id smallint primary key default 1 check (id = 1),
       provider text, docs_url text,
       -- as_of_date / last_checked_at hold the app's ISO strings verbatim; text
       -- (not date/timestamptz) so they round-trip exactly (pg would return a Date).
       as_of_date text, last_checked_at text, last_error text,
       default_quote_currency text not null default 'MXN',
       pairs jsonb not null default '[]'::jsonb,
       updated_at timestamptz not null default now()
     )`,

    // B′.2 carriers (handover-authoritative; customs mirror collapses here)
    `create table if not exists ${s}.carriers (
       id text primary key,
       name text not null,
       code text, rfc text,
       notes_extra jsonb not null default '{}'::jsonb,
       customs_note text,
       active boolean not null default true,
       invoice_to_consignee_only boolean not null default false,
       demurrage_cutoff_handled_by text,
       sort_order integer not null default 0,
       container_groups jsonb not null default '[]'::jsonb,
       demurrage jsonb not null default '{}'::jsonb,
       guarantee jsonb not null default '{}'::jsonb,
       terminal_mix jsonb not null default '[]'::jsonb,
       quote_defaults jsonb not null default '{}'::jsonb,
       extra jsonb not null default '{}'::jsonb,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
    // Catch-all for any handover shippingLine top-level field not promoted to a
    // column (invoiceNote + any future/unknown spread field) — handover lines are
    // the only entity built with `...shippingLine`, so only carriers needs this.
    `alter table ${s}.carriers add column if not exists extra jsonb not null default '{}'::jsonb`,
    `create table if not exists ${s}.carrier_local_charges (
       id text primary key,
       carrier_id text not null references ${s}.carriers(id) on delete cascade,
       concept text not null, note text,
       tax_rate numeric(8,4) not null default 0,
       group_rates jsonb not null default '{}'::jsonb,
       bl_rate jsonb,
       sort_order integer not null default 0
     )`,
    `create index if not exists carrier_local_charges_carrier_idx
       on ${s}.carrier_local_charges (carrier_id)`,

    // B′.3 container_types (handover master; customs shares)
    `create table if not exists ${s}.container_types (
       key text primary key,
       label text not null,
       rate_group text not null,
       sort_order integer not null default 0
     )`,

    // B′.4 customs ports / terminals (+ charges) / yards (+ charges) + joins
    `create table if not exists ${s}.customs_ports (
       id text primary key, name text not null, note text,
       sort_order integer not null default 0,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
    `create table if not exists ${s}.customs_terminals (
       id text primary key,
       port_id text not null references ${s}.customs_ports(id) on delete cascade,
       name text not null, note text,
       sort_order integer not null default 0,
       storage_config jsonb not null default '{}'::jsonb,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
    `create index if not exists customs_terminals_port_idx
       on ${s}.customs_terminals (port_id)`,
    `create table if not exists ${s}.terminal_charges (
       id text primary key,
       terminal_id text not null references ${s}.customs_terminals(id) on delete cascade,
       concept text not null, note text,
       tax_rate numeric(8,4) not null default 0,
       group_rates jsonb not null default '{}'::jsonb,
       basis text not null default 'per_occurrence' check (basis in ('per_day','per_occurrence')),
       required boolean not null default false,
       amount numeric(14,4), amount_currency text default 'MXN',
       sort_order integer not null default 0
     )`,
    `create index if not exists terminal_charges_terminal_idx
       on ${s}.terminal_charges (terminal_id)`,
    `create table if not exists ${s}.customs_yards (
       id text primary key, name text not null, note text,
       sort_order integer not null default 0,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
    `create table if not exists ${s}.yard_charges (
       id text primary key,
       yard_id text not null references ${s}.customs_yards(id) on delete cascade,
       kind text not null check (kind in ('dropoff','customs')),
       concept text not null, note text,
       tax_rate numeric(8,4) not null default 0,
       group_rates jsonb not null default '{}'::jsonb,
       basis text not null default 'per_occurrence' check (basis in ('per_day','per_occurrence')),
       required boolean not null default false,
       amount numeric(14,4), amount_currency text default 'MXN',
       sort_order integer not null default 0
     )`,
    `create index if not exists yard_charges_yard_idx
       on ${s}.yard_charges (yard_id)`,
    `create table if not exists ${s}.yard_ports (
       yard_id text references ${s}.customs_yards(id) on delete cascade,
       port_id text references ${s}.customs_ports(id) on delete cascade,
       seq integer not null default 0,
       primary key (yard_id, port_id)
     )`,
    `create table if not exists ${s}.yard_carriers (
       yard_id text references ${s}.customs_yards(id) on delete cascade,
       carrier_id text references ${s}.carriers(id) on delete cascade,
       seq integer not null default 0,
       primary key (yard_id, carrier_id)
     )`,

    // B′.5 inland origins / destinations / rate entries / route cache (cold)
    `create table if not exists ${s}.inland_origins (
       id text primary key, name text not null,
       lat double precision, lng double precision,
       sort_order integer not null default 0
     )`,
    `create table if not exists ${s}.inland_destinations (
       id text primary key,
       name text not null, name_zh text, name_es text, state text,
       lat double precision, lng double precision,
       coord_source text, needs_review boolean not null default false,
       image_urls jsonb not null default '[]'::jsonb,
       precise_points jsonb not null default '[]'::jsonb,
       enabled boolean not null default true, note text,
       sort_order integer not null default 0,
       created_at timestamptz not null default now(),
       updated_at timestamptz not null default now()
     )`,
    `create table if not exists ${s}.inland_rate_entries (
       id text primary key,
       origin_id text references ${s}.inland_origins(id),
       destination_id text not null references ${s}.inland_destinations(id) on delete cascade,
       proveedor text, dup_index integer not null default 1,
       cliente text, codigo_cw text, commodity text,
       sencillo numeric(14,4), "full" numeric(14,4),
       burreo jsonb,
       vehicle_prices jsonb not null default '{}'::jsonb,
       currency text not null default 'MXN',
       enabled boolean not null default true, note text,
       extras jsonb not null default '{}'::jsonb,
       sort_order integer not null default 0
     )`,
    `create index if not exists inland_rate_entries_destination_idx
       on ${s}.inland_rate_entries (destination_id)`,
    `create table if not exists ${s}.inland_route_cache (
       id text primary key,
       origin_id text references ${s}.inland_origins(id),
       destination_id text not null references ${s}.inland_destinations(id) on delete cascade,
       target_type text not null default 'destination' check (target_type in ('destination','precisePoint')),
       target_id text,
       encoded_polyline text,
       distance_km numeric, duration_min numeric,
       via_cities jsonb not null default '[]'::jsonb,
       engine text default 'osrm', fetched_at text,
       stale boolean not null default false, has_ferry boolean not null default false,
       manual_override jsonb,
       sort_order integer not null default 0,
       unique (origin_id, destination_id, target_type, target_id)
     )`,
    `create index if not exists inland_route_cache_destination_idx
       on ${s}.inland_route_cache (destination_id)`,

    // B′.6 quote drafts / notes + module settings
    `create table if not exists ${s}.quote_drafts (
       id text primary key, number text, date text,
       header jsonb not null default '{}'::jsonb, quote_mode text,
       line_items jsonb not null default '[]'::jsonb,
       note_ids jsonb not null default '[]'::jsonb,
       -- created_at/updated_at hold the draft's app ISO strings → text, exact round-trip.
       language text, created_at text, updated_at text,
       sort_order integer not null default 0
     )`,
    `create table if not exists ${s}.quote_notes (
       id text primary key, en text, es text, zh text,
       sort_order integer not null default 0
     )`,
    `create table if not exists ${s}.module_settings (
       module_key text primary key,
       settings jsonb not null default '{}'::jsonb,
       tax_rate_presets jsonb not null default '[]'::jsonb
     )`,
  ];
}

// The relational tables this migration owns (for verification / teardown).
const RELATIONAL_TABLES = Object.freeze([
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
]);

// Drop all relational tables (sandbox reset during development). Reverse FK
// order is unnecessary with `cascade`.
function buildDropDDL(schemaName) {
  const s = q(schemaName);
  return RELATIONAL_TABLES.map(
    (table) => `drop table if exists ${s}.${q(table)} cascade`
  );
}

module.exports = { buildSchemaDDL, buildDropDDL, RELATIONAL_TABLES, q };
