# Database Schema

> Last verified against PROD: **2026-06-25** (read-only introspection of `expressline` on Supabase project `polxyashvxbzdkkmxuox`). Full evidence + a graded structure health check: [docs/specs/20260625_db_structure_health_check_REPORT.md](specs/20260625_db_structure_health_check_REPORT.md). Migration close-out: [docs/MIGRATION_COMPLETE_20260625.md](MIGRATION_COMPLETE_20260625.md).

## Current status (post blob→relational migration)

- **Persistence reality:** production runs on **Supabase Postgres**, schema **`expressline`**, with **`STORAGE_MODE=relational`** — the app reads/writes **18 relational entity tables**, not the legacy JSON blob. The old `app_state.shipping-data` blob has been **retired** (frozen as a rollback anchor). This is no longer "JSON vs Supabase, unresolved" — the relational store is live.
- **Driver selection** ([src/lib/db/index.js#shouldUseDatabase](../src/lib/db/index.js#L28)): Postgres is used when `DATABASE_URL` is set (or `STORAGE_DRIVER=postgres`); `STORAGE_DRIVER=json` forces the local JSON fallback (tests + local dev). `STORAGE_MODE` (`blob` | `relational` | `dual`, default `blob`) selects the DB-mode backend; **prod is `relational`** ([src/lib/store/index.js#getStorageMode](../src/lib/store/index.js#L224)).
- **Shared project:** `polxyashvxbzdkkmxuox` hosts `expressline` **and** two other businesses (`public.joyas_*`, `public.punas_*`) — see the multi-project section below.

## Multi-project layout — this Supabase project hosts 3 businesses

The Supabase project `polxyashvxbzdkkmxuox` is shared by **three independent apps**. Full census + cross-project boundary verification: [docs/specs/20260625_cross_project_db_layout.md](specs/20260625_cross_project_db_layout.md).

| Project | Business | Isolation | Recognize by |
|---|---|---|---|
| **Express Line** (this repo) | logistics cost workbench | dedicated schema | the `expressline` schema (21 tables) |
| **Althea** | jewelry marketing/content platform | `public` + `joyas_` prefix | `public.joyas_*` (18 tables) |
| **pang uñas** | nail-salon appointments/POS | `public` + `punas_` prefix | `public.punas_*` (12 tables) |

- **Separation verified clean (2026-06-26):** 51 business tables, **0 unknown**, every `public` table consistently prefixed, **no FK crosses between the 3 business projects**, `expressline` is FK-isolated, no business views. (Only cross-schema FKs are `punas_*→auth.users` — Supabase Auth, pang uñas's own integration.)
- **Iron rule:** this repo's tooling touches **only `expressline`** (schema-qualified + `assertProd`-gated). `joyas_*` / `punas_*` are **never read (data) or modified** — they belong to the Althea / pang uñas apps. The shared instance means shared connection/egress/storage quota.
- **App runtime role — least-privilege (2026-06-26):** the live app connects as **`expressline_app`**, NOT `postgres`. `expressline_app` has CRUD on the 18 entity tables + `app_state` R/W + `quote_snapshots` INSERT + `expressline` schema USAGE, and is **denied (42501) on `joyas_*` / `punas_*`** — so even though the app has no auth, a visitor cannot reach the other projects' data through it. `postgres` is retained as the owner (fresh-DB setup / migrations), and the app no longer self-migrates at runtime (`db/index.js#relationExists` skips owner-DDL when the schema exists). Role/grants: `scripts/relational/app-role-grants.js`; created by `prod-F-create-app-role.js`. Rollback anchor: Railway var `DATABASE_URL_POSTGRES_BACKUP`.
- **Long-term note:** Express Line's dedicated-schema model is the more robust isolation than `public` prefixes (hard role boundary, no prefix-typo risk). Migrating `joyas`/`punas` to their own schemas would require changing those apps — **not this repo's call**. Details + rationale in the layout doc.

## Object inventory — `expressline` (21 tables + 2 sequences; no views)

**18 relational entity tables** (the live store under `STORAGE_MODE=relational`). Canonical DDL: [relational-repo.js#buildSchemaDDL](../src/lib/db/relational-repo.js#L32); column/jsonb metadata: [relational-map.js#TABLE_META](../src/lib/db/relational-map.js#L530). (Both moved from `lib/store/` to `lib/db/` on 2026-06-25 — M4 remediation.) Row counts as of 2026-06-25.

### Handover (换单) + shared masters

- **`carriers`** (21) — 船公司 master, **authoritative on the handover side** (customs mirrors it on read). PK `id` (text). Promoted columns `name`, `active`, `invoice_to_consignee_only`, `demurrage_cutoff_handled_by`, `sort_order`; jsonb leaves `notes_extra`, `customs_note`, `container_groups`, `demurrage`, `guarantee`, `terminal_mix`, `quote_defaults`, `extra` (exact-reconstruction spill). `created_at`/`updated_at` = `timestamptz`. ⚠ `code`/`rfc` columns are write-only duplicates of `notes_extra.{code,rfc}` (report M3).
- **`carrier_local_charges`** (45) — per-carrier local charges. PK `id`; FK `carrier_id → carriers.id` **ON DELETE CASCADE** (indexed). `tax_rate numeric(8,4)`, `group_rates`/`bl_rate` jsonb.
- **`container_types`** (20) — container-type master. PK `key` (text); `rate_group` maps a container to its rate group (`RATE_GROUP_NAMES` domain, not CHECK-constrained).

### Customs (清关 / Despacho)

- **`customs_ports`** (2) — ports. PK `id`.
- **`customs_terminals`** (7) — terminals per port. PK `id`; FK `port_id → customs_ports.id` CASCADE (indexed). `storage_config` jsonb holds the whole storage-rule subtree (`storageRuleSets`, `storageAssignmentsBy*`, …).
- **`terminal_charges`** (7) — terminal fixed charges. PK `id`; FK `terminal_id → customs_terminals.id` CASCADE (indexed). `basis` CHECK `(per_day|per_occurrence)`; `amount numeric(14,4)`.
- **`customs_yards`** (28) — yards (patios). PK `id`.
- **`yard_charges`** (56) — yard charges. PK `id`; FK `yard_id → customs_yards.id` CASCADE (indexed). `kind` CHECK `(dropoff|customs)`; `basis` CHECK `(per_day|per_occurrence)`; `amount numeric(14,4)`.
- **`yard_ports`** (28) — yard↔port join. Composite PK `(yard_id, port_id)`; both FKs CASCADE.
- **`yard_carriers`** (**0**) — yard↔carrier join. Composite PK `(yard_id, carrier_id)`; both FKs CASCADE. **Currently empty** → yards are scoped by port only (carrier dimension unpopulated; report m8).

### Inland (陆运 / Transporte)

- **`inland_origins`** (1) — origins. PK `id`; `lat`/`lng` = `double precision`.
- **`inland_destinations`** (44) — destinations. PK `id`; i18n names (`name_zh`/`name_es`), `lat`/`lng`, `image_urls`/`precise_points` jsonb. `created_at`/`updated_at` = `timestamptz`.
- **`inland_rate_entries`** (300) — rate table. PK `id`; FK `destination_id → inland_destinations.id` CASCADE (indexed), FK `origin_id → inland_origins.id` **NO ACTION**. `sencillo`/`full numeric(14,4)`; `vehicle_prices`/`burreo`/`extras` jsonb.
- **`inland_route_cache`** (44) — OSRM route cache. PK `id`; FKs to destination (CASCADE, indexed) + origin (NO ACTION). Natural **UNIQUE `(origin_id, destination_id, target_type, target_id)`** prevents dup cache rows; `target_type` CHECK `(destination|precisePoint)`.

### Quote + settings

- **`quote_drafts`** (0) — saved quote drafts. PK `id`; `header`/`line_items`/`note_ids` jsonb.
- **`quote_notes`** (5) — reusable quote remarks (en/es/zh). PK `id`.
- **`module_settings`** (5) — per-module settings + `tax_rate_presets`. PK `module_key` (values: `handover`/`customs`/`inland`/`quote` + a `__app__` meta row carrying `generatedFrom`).
- **`exchange_rates`** (1) — USD/MXN snapshot + FX metadata. **Singleton:** PK `id smallint` with CHECK `(id = 1)`; `pairs` jsonb.

### Carry-over / auxiliary tables (created by [db.js#migrateDatabase](../src/lib/db/index.js#L69))

- **`app_state`** (2 rows) — legacy blob table. Keys: **`shipping-data-retired-20260625`** (the frozen ~1.24 MB pre-cutover blob, kept as rollback anchor) + **`users`** (live auth source, 359 B — *not* migrated to a relational table; passwords plaintext). The live `shipping-data` key is gone → cutover complete.
- **`quote_snapshots`** (5) — append-only audit of generated quotes (written by [workbench.js:374](../src/routes/workbench.js#L374); currently write-only — `listQuoteSnapshots` has no caller).
- **`audit_logs`** (0) — **dead scaffolding**: created by the migrator but no code path writes it (report m1). Either wire it up or drop it.

## Storage model (how the app reads/writes)

- **Read:** `getShippingData()` → in-process cache (DB mode; ~1h TTL, write-through) → on miss, `getShippingTablesAssembled()` reads all 18 tables (`select *`, no filter) and `assemble()`s the shipping-data shape, then `normalizeShippingData()` ([src/lib/store/index.js#getShippingData](../src/lib/store/index.js#L257)). The cache is the egress guard — a single uncached large-object read per request previously blew the free egress tier ~70×.
- **Write:** targeted, per-entity, single-transaction writes avoid full-table overwrites and cross-entity clobber — `saveModuleTables` (module-scoped), `saveCarrierEntity` / `saveCustomsYardEntity` / `saveInlandRateEntryEntity` (single entity), `saveExchangeRatesTable` (FX singleton only). See [src/lib/db/index.js](../src/lib/db/index.js#L293).
- **JSON fallback** (local/tests, `STORAGE_DRIVER=json`): reads/writes `data/shipping-lines.json` + `data/users.json`; no DB, no cache.

## Safety rules

- Do not print or store real `DATABASE_URL`, database passwords, Supabase service keys, session secrets, cookies, or API keys.
- Do not run `npm run db:seed` against production without explicit confirmation — seed writes repository data into `expressline.app_state` and can overwrite online config.
- Keep this project inside `DATABASE_SCHEMA=expressline` unless a reviewed migration plan says otherwise. **Never touch `public.joyas_*` / `public.punas_*`** — shared project, different tenants.
- PROD scripts must pass the ref guard (`assertProd` → `ref == polxyashvxbzdkkmxuox`, [scripts/relational/prod-guard.js](../scripts/relational/prod-guard.js)); the restricted `expressline_migrator` role enforces schema-level isolation. Any structural change is **DDL** — review and run as a migration, never ad-hoc against prod.
- After any out-of-band prod data write (`scripts/patch-prod-data.js`, `db:seed`), redeploy/restart the app so its warm in-process cache does not clobber or mask the change.

## Migration / verification commands

- `npm run db:migrate` — create base tables (`app_state`/`audit_logs`/`quote_snapshots`); relational entity tables are created idempotently by `ensureRelationalReady`.
- `npm run db:seed` — seed repository data into `app_state` (⚠ guarded; not for prod without confirmation).
- `npm run db:check` — connectivity / schema sanity check.
- `npm run test:all` — full in-process suite (14 JSON-mode + relational round-trip / parity / seed-guard audits). The parity and round-trip gates fail loudly if the blob↔table mapping drifts.
- Relational-specific tooling lives under `scripts/relational/` (parity, round-trip, prod health check, cutover/reverse runbook scripts).

## Structural remediation status (from the 2026-06-25 health check)

From the [structure health check](specs/20260625_db_structure_health_check_REPORT.md) — **no Critical defects**. Line CLOSED — see [DATABASE_CONSOLIDATION_COMPLETE_20260625.md](specs/DATABASE_CONSOLIDATION_COMPLETE_20260625.md).

- ✅ **DONE (applied to prod + merged to main):**
  - **M4** — the `lib/db → lib/store` reverse import was removed (the two leaves moved into `lib/db/`).
  - **M1** — 7 money/rate non-negativity `CHECK`s now enforced (`carrier_local_charges.tax_rate`, `terminal_charges.tax_rate`/`amount`, `yard_charges.tax_rate`/`amount`, `inland_rate_entries.sencillo`/`full` — all `≥ 0`).
  - **m3 indexes** — the 3 missing FK indexes added (`inland_rate_entries.origin_id`, `yard_carriers.carrier_id`, `yard_ports.port_id`).
- ⏸ **Deferred to a human decision** (see [remediation decisions](specs/20260625_db_remediation_DECISIONS.md)):
  - **M2** — domain date fields are `text` (→ `date`/`timestamptz` needs a code change first; app reads them as strings).
  - **M3** — drop write-only `carriers.code`/`carriers.rfc` (duplicates of `notes_extra`).
  - **m1** — `audit_logs` dead table (wire or drop); `quote_snapshots` unbounded growth (reader/retention).
  - jsonb rate cells are JSON floats (app-layer validation, not column-`CHECK`-able); enum/name constraints held (couple DB to mutable code/names).
  - Auth not enforced + plaintext passwords — **separate spec-first project** (not in this line).
