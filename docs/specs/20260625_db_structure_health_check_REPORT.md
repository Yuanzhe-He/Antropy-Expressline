# Express Line — Database Structure Health Check (READ-ONLY)

- Date: 2026-06-25
- Scope: `expressline` schema on PROD Supabase project `polxyashvxbzdkkmxuox` (shared with `public.joyas_*` / `public.punas_*`).
- Mode: **READ-ONLY**. Evidence gathered with `information_schema` / `pg_catalog` metadata reads + `count(*)` + `pg_column_size` only. **No DDL, no data mutation.** Blob payloads were never pulled (sizes via `pg_column_size`). `joyas_*` / `punas_*` **data** never read — only constraint metadata, to prove isolation.
- Connection: `scripts/relational/prod-env.js#connectProdAdmin` → asserts `ref == polxyashvxbzdkkmxuox` before opening the pool ([prod-guard.js:42](../../scripts/relational/prod-guard.js#L42)).
- Method spirit: read-only, evidence-driven, graded (🔴 Critical / 🟡 Major / 🟢 Minor), each finding cites introspection output or `file:line`. Mirrors the architecture-health-check framework (`Cursor Project Master/architecture/frameworks/architecture-health-check.md`); no DB-specific framework existed, so the check items below were defined for this pass.

> **Context.** "Express Line 优化" ran on two tracks: ① DB optimization (the blob→relational migration, closed — see [MIGRATION_COMPLETE_20260625.md](../MIGRATION_COMPLETE_20260625.md)) and ② architecture optimization (the 2026-06-22 god-file refactor, closed). This report fills the two gaps neither track covered: **a structural health audit of the post-migration schema** (PART 1) and a **light architecture re-check of the migration-added relational layer** (PART 2). PART 3 (baseline-doc refresh) is tracked separately in the task summary.

---

> **Remediation status (2026-06-25, this report acted on).** Safe, high-value items were executed; risky/irreversible items were turned into decision-ready proposals (not executed). **Done:** M4 reverse edge fixed (the two leaves moved to `lib/db/`; `test:all` 20/20); M1 money/rate non-negativity `CHECK`s + the 3 missing FK indexes applied to prod (non-destructive, read-verified, revertable). **Deferred to a human decision** (see [20260625_db_remediation_DECISIONS.md](20260625_db_remediation_DECISIONS.md)): M2 (text→date type migration), M3 (drop/keep `carriers.code`/`rfc`), `audit_logs` (wire/drop), `quote_snapshots` (reader/retention), and the auth/plaintext-password security item (spec-first). The findings below are the original audit; file:line links point at the post-move `lib/db/` paths.

## TL;DR / Verdict

**No 🔴 Critical structural defects.** The relational schema is well-formed: every entity has a primary key, parent/child relationships are FK-constrained with sensible `on delete` behavior, the singleton and enum columns carry `CHECK` constraints, and **`expressline` is cleanly isolated** — zero foreign keys cross into or out of the schema. Promoted money columns correctly use `numeric`, not `float`.

Findings are **hardening (🟡 Major) and hygiene (🟢 Minor)** items:

| # | Grade | Finding | Area |
|---|-------|---------|------|
| M1 | 🟡 Major | No sanity `CHECK`s on money/rate columns (`tax_rate`, `amount`, `sencillo`, `full` ≥ 0); rate cells inside `group_rates` / `vehicle_prices` / `burreo` are JSON floats, not `numeric` | constraints / types |
| M2 | 🟡 Major | Domain temporal fields stored as `text` (`exchange_rates.as_of_date`/`last_checked_at`, `inland_route_cache.fetched_at`, `quote_drafts.date`/`created_at`/`updated_at`) | data types |
| M3 | 🟡 Major | `carriers.code` / `carriers.rfc` are write-only denormalized duplicates of `notes_extra.{code,rfc}` — populated by `decompose`, never read by `assemble` → drift risk + dead columns | normalization |
| M4 | 🟡 Major **[RESOLVED 2026-06-25]** | `lib/db.js` imported `lib/store/relational-{map,repo}` — a reverse layer edge vs the documented `routes→lib→store→db`; "no reverse imports" was false (no runtime cycle). **Fixed:** `db.js`→`db/index.js` + the two leaves moved to `lib/db/`. | architecture (PART 2) |
| m1 | 🟢 Minor | `audit_logs` table created by the migrator but has **no writer anywhere** — dead scaffolding (0 rows) | dead structure |
| m2 | 🟢 Minor | `quote_snapshots` is write-only (`listQuoteSnapshots` never called) — telemetry only | dead-ish structure |
| m3 | 🟢 Minor | 3 FK columns lack a supporting index (`inland_rate_entries.origin_id`, `yard_carriers.carrier_id`, `yard_ports.port_id`) — below the pain threshold at current row counts | index coverage |
| m4 | 🟢 Minor | No enum `CHECK` on `module_settings.module_key` / `container_types.rate_group`; no natural-key `UNIQUE` on entity names | constraint coverage |
| m5 | 🟢 Minor | Logical references buried in `jsonb` (`carriers.terminal_mix`, `quote_drafts.note_ids`, terminal storage assignments) can't be FK-constrained — inherent hybrid-jsonb tradeoff | FK integrity |
| m6 | 🟢 Minor | `users` still lives in the `app_state` blob (not migrated to a relational table); passwords are plaintext in that payload | data model / security debt |
| m7 | 🟢 Minor | `app_state` retains the 1.24 MB frozen `shipping-data-retired-20260625` blob — intentional rollback anchor; dead weight once the rollback window closes | legacy |
| m8 | 🟢 Minor | `yard_carriers` is empty (0 rows) — yards are presently scoped by **port only**; carrier-scoping data is not populated (data-state, not a schema defect) | data observation |

**Recommended next action:** M1–M3 are small, additive, reversible schema-hardening changes (new `CHECK`s, a `text→timestamptz` typing pass, dropping two dead columns) — package them as one reviewed migration. M4 is a pure-move refactor (relocate two leaf modules), risk-equivalent to the 2026-06-22 god-file move. None are urgent; the schema is production-healthy as-is.

---

## PART 1 — Database Structure Health Check

### 1.1 Real schema snapshot (the ground truth `DATABASE_SCHEMA.md` was missing)

`expressline` contains **21 tables + 2 sequences** (no views, no materialized views). That is **18 relational entity tables + 3 carry-over/auxiliary tables** (`app_state`, `audit_logs`, `quote_snapshots`) — note the baseline framing of "18 + app_state" undercounted by two (the two auxiliary tables created in [db.js#migrateDatabase](../../src/lib/db.js#L69)).

**The 18 relational entity tables** (the live store under `STORAGE_MODE=relational`), with exact row counts and on-disk size:

| Table | Rows | Total size | PK | Purpose |
|---|---:|---:|---|---|
| `exchange_rates` | 1 | 32 kB | `(id)` singleton, `CHECK id=1` | USD/MXN pair snapshot + FX metadata |
| `carriers` | 21 | 352 kB | `(id)` | 船公司 master (handover authoritative; customs mirrors on read) |
| `carrier_local_charges` | 45 | 128 kB | `(id)` | per-carrier local charges (换单 local fees) |
| `container_types` | 20 | 64 kB | `(key)` | container-type master + rate-group mapping |
| `customs_ports` | 2 | 32 kB | `(id)` | 清关 ports |
| `customs_terminals` | 7 | 112 kB | `(id)` | terminals per port (+ `storage_config` jsonb) |
| `terminal_charges` | 7 | 80 kB | `(id)` | terminal fixed charges |
| `customs_yards` | 28 | 80 kB | `(id)` | 清关 yards (patios) |
| `yard_charges` | 56 | 248 kB | `(id)` | yard dropoff + customs charges (`kind` discriminator) |
| `yard_ports` | 28 | 64 kB | `(yard_id, port_id)` | yard↔port join |
| `yard_carriers` | **0** | 16 kB | `(yard_id, carrier_id)` | yard↔carrier join (**empty** — see m8) |
| `inland_origins` | 1 | 32 kB | `(id)` | 陆运 origins |
| `inland_destinations` | 44 | 72 kB | `(id)` | 陆运 destinations (i18n names, coords, precise points) |
| `inland_rate_entries` | 300 | 800 kB | `(id)` | 陆运 rate table (sencillo/full/vehicle prices) |
| `inland_route_cache` | 44 | 1.4 MB | `(id)` + natural `UNIQUE` | OSRM route cache (polyline/distance/duration) |
| `quote_drafts` | 0 | 16 kB | `(id)` | saved quote drafts |
| `quote_notes` | 5 | 32 kB | `(id)` | reusable quote remarks library |
| `module_settings` | 5 | 32 kB | `(module_key)` | per-module settings + tax presets + `__app__` meta row |

Row counts match the cutover baseline exactly (`carriers 21, customs_yards 28, inland_destinations 44, inland_rate_entries 300, container_types 20, quote_notes 5, module_settings 5` — see [prod-health-check.js:8](../../scripts/relational/prod-health-check.js#L8)) → **data is stable, no drift since cutover.**

**The 3 carry-over/auxiliary tables:**

| Table | Rows | Status |
|---|---:|---|
| `app_state` | 2 | blob-era table. Holds `shipping-data-retired-20260625` (rev **215132**, **1.24 MB**, frozen rollback anchor) + `users` (rev 1, 359 B, **still live** — auth source). The live `shipping-data` key is **gone** → cutover confirmed complete. |
| `quote_snapshots` | 5 | append-only quote audit. **Written** by [workbench.js:374](../../src/routes/workbench.js#L374); **never read** (`listQuoteSnapshots` defined in db.js but uncalled). Telemetry. |
| `audit_logs` | 0 | created by [db.js:87](../../src/lib/db.js#L87); **no writer anywhere** (grep of `src/` + `scripts/` finds only the `CREATE TABLE`). Dead scaffolding. |

Sequences: `audit_logs_id_seq`, `quote_snapshots_id_seq` (owned by their tables).

The canonical DDL lives in [relational-repo.js#buildSchemaDDL](../../src/lib/db/relational-repo.js#L32); the column/jsonb metadata in [relational-map.js#TABLE_META](../../src/lib/db/relational-map.js#L530). The live PROD schema matches that DDL (verified column-by-column against introspection).

### 1.2 Health-check items

#### Normalization quality — 🟢 sound hybrid design, one real defect (M3)

The migration decomposed the old ~1.6 MB blob into **top-level entity tables with `jsonb` leaves for variable/nested config**. This hybrid is **intentional and defensible** — the `jsonb` columns (`carriers.container_groups`/`demurrage`/`guarantee`/`terminal_mix`, `*.group_rates`, `customs_terminals.storage_config`, `inland_*.vehicle_prices`/`precise_points`, `quote_drafts.line_items`, `module_settings.settings`) hold genuinely variable-shape, whole-entity-read/write config at low cardinality. These are **not** "该拆没拆" — normalizing them into rows would add joins and churn for no query benefit at this scale.

- 🟡 **M3 — `carriers.code` / `carriers.rfc` are write-only denormalized duplicates.** `decompose` sets `code: notes.code`, `rfc: notes.rfc` **and** stores the whole `notes` object as `notes_extra` ([relational-map.js:73-76](../../src/lib/db/relational-map.js#L73)). But `assemble` reconstructs the carrier from `notes_extra` only and **never reads `row.code` / `row.rfc`** ([relational-map.js:337](../../src/lib/db/relational-map.js#L337)). So the two columns are populated on every write but are dead on read — a denormalized copy that can silently drift from the authoritative `notes_extra.{code,rfc}` if anything ever writes one without the other. *Fix:* either drop `carriers.code` / `carriers.rfc` (and read from `notes_extra` if SQL reporting needs them), or make `assemble` read them back and treat them as authoritative — but not both-and-ignore-one.
- 🟢 The `carriers` table carries `notes_extra` **and** an `extra` catch-all **and** promoted columns — a wide table (18 cols, 8 of them jsonb), but each has a clear role (`extra` = exact-reconstruction spill for unknown spread fields, [relational-map.js:64-69](../../src/lib/db/relational-map.js#L65)). Acceptable.

#### FK integrity — 🟢 complete and sensible

**12 foreign keys**, every parent/child relationship constrained, `on delete` behavior is coherent:

```
carrier_local_charges.carrier_id   -> carriers.id              del=CASCADE
customs_terminals.port_id          -> customs_ports.id         del=CASCADE
terminal_charges.terminal_id       -> customs_terminals.id     del=CASCADE
customs_yards (via) yard_charges.yard_id -> customs_yards.id   del=CASCADE
yard_ports.yard_id  -> customs_yards.id / yard_ports.port_id -> customs_ports.id   del=CASCADE
yard_carriers.yard_id -> customs_yards.id / yard_carriers.carrier_id -> carriers.id del=CASCADE
inland_rate_entries.destination_id -> inland_destinations.id   del=CASCADE
inland_rate_entries.origin_id      -> inland_origins.id        del=NO ACTION
inland_route_cache.destination_id  -> inland_destinations.id   del=CASCADE
inland_route_cache.origin_id       -> inland_origins.id        del=NO ACTION
```

- Child charges and join rows **CASCADE** from their parent (deleting a carrier removes its local charges + yard links; deleting a yard removes its charges/ports/carriers) — correct: a child is meaningless without its parent.
- `origin_id` uses **NO ACTION** (restrict-like) — deleting an origin that still has rate entries / cache rows is *blocked* rather than cascading. Defensible (origins are a tiny, near-static set — only 1 row) but **asymmetric** with `destination_id` CASCADE. Worth a conscious decision, not a bug.
- 🟢 **m5 — logical references buried in `jsonb` cannot be FK-constrained:** `carriers.terminal_mix` → terminal ids, `quote_drafts.note_ids` → `quote_notes.id`, `customs_terminals.storage_config.storageAssignmentsByLineContainer` → carrier/container ids, `yard.shippingLineIds`/`portIds` (these last two *are* normalized into join tables, good). The remaining jsonb-embedded references rely on app-layer integrity. Inherent cost of the hybrid design; flag, don't "fix."
- No dangling logical FK among the **promoted columns** — every column that names another entity is constrained.

#### Index coverage — 🟢 adequate; 3 textbook gaps below pain threshold (m3)

- All 7 explicit secondary indexes back FK columns (`carrier_local_charges_carrier_idx`, `customs_terminals_port_idx`, `terminal_charges_terminal_idx`, `yard_charges_yard_idx`, `inland_rate_entries_destination_idx`, `inland_route_cache_destination_idx`) + the `inland_route_cache` natural `UNIQUE`. 28 indexes total (21 PK + 7 secondary).
- 🟢 **m3 — 3 FK columns have no supporting index:** `inland_rate_entries.origin_id`, `yard_carriers.carrier_id`, `yard_ports.port_id`. The last two are the **non-leading column of a composite PK** (the PK index covers `(yard_id, …)`, not `carrier_id`/`port_id` alone), so a cascade delete from `carriers`/`customs_ports` does a seqscan of `yard_carriers`/`yard_ports`. At **0 / 28 rows** this is free; add the indexes only if these join tables grow into the thousands.
- **Hot read path is index-agnostic:** `getShippingTablesAssembled` does `select * from <each table>` with no `where` ([relational-repo.js#readAllTables:275](../../src/lib/db/relational-repo.js#L275)) and assembles in memory, then the whole result is cached in-process for ~1h ([store/index.js:36-67](../../src/lib/store/index.js#L36)). So per-request reads collapse to cache hits with zero DB egress; the relational reads are bounded full scans of small tables. Indexes here matter for integrity/cascades, not for the read path. **No missing hot-path index.**
- **No removable / redundant index.** The 6 zero-`idx_scan` indexes (`pg_stat_user_indexes`) are FK/unique supports on low-traffic tables (`quote_*`, `yard_carriers`, `customs_terminals_port_idx`) or protect integrity — keep them; the zero count reflects the full-scan assemble path, not dead weight.

#### Constraint coverage — 🟡 money/enum/natural-key gaps (M1, m4)

- **NOT NULL:** core identity, parent FK, and required label columns are `NOT NULL` everywhere. Nullable-heavy tables (`inland_rate_entries` 9/17, `inland_route_cache` 8/15, `quote_drafts` 6/11) are nullable on genuinely optional fields (optional pricing, cache metadata, draft fields). No over-permissive core column.
- 🟡 **M1 — no money/rate sanity `CHECK`s.** `tax_rate numeric(8,4)`, `amount numeric(14,4)`, `inland_rate_entries.sencillo`/`full numeric(14,4)` accept **negatives and absurd magnitudes** at the DB layer — only app-level validation guards them. Add `CHECK (tax_rate >= 0)`, `CHECK (amount >= 0)`, `CHECK (sencillo >= 0)` etc. as defense-in-depth. (Rate cells inside `group_rates`/`vehicle_prices`/`burreo` jsonb can't be `CHECK`ed and are JSON floats — see M1-types below.)
- 🟢 **m4 — enum/natural-key gaps:** `module_settings.module_key` has no `CHECK` (real values: `handover`/`customs`/`inland`/`quote`/`__app__`); `container_types.rate_group` has no `CHECK` against the `RATE_GROUP_NAMES` domain; entity names (`carriers.name`, `customs_yards.name`, `customs_ports.name`, `inland_destinations.name`) have **no natural-key `UNIQUE`** — two yards with the same name are storable (the app keys by synthetic text id, so this is by-design but means name-dup prevention is app-only).
- **Good constraints already present:** `exchange_rates CHECK (id = 1)` (singleton), `inland_route_cache.target_type IN ('destination','precisePoint')`, `terminal_charges.basis IN ('per_day','per_occurrence')`, `yard_charges.basis IN (...)`, `yard_charges.kind IN ('dropoff','customs')`, and the `inland_route_cache (origin_id,destination_id,target_type,target_id)` natural `UNIQUE` that prevents duplicate cache rows.

#### Data-type correctness — 🟡 money mostly right, dates wrong (M1-types, M2)

- ✅ **Money uses `numeric`, not `float`** in every promoted column: `tax_rate numeric(8,4)`, `amount numeric(14,4)`, `sencillo`/`full numeric(14,4)`. No 🔴 float-stores-money defect.
- ✅ Coordinates use `double precision` (`lat`/`lng`) — correct for geo.
- 🟡 **M1-types — rate cells inside jsonb are JSON floats.** The most common money values — the per-rate-group cells in `group_rates`, the per-vehicle prices in `vehicle_prices`, `burreo` — live inside `jsonb` and are therefore IEEE-754 doubles, not `numeric`. Safe at current magnitudes (prices ≤ ~10⁶ with ≤ 4 decimals are exactly representable), but not type-safe and not constrainable. Inherited from the blob shape; flag as a known tradeoff of keeping rate maps in jsonb.
- 🟡 **M2 — domain temporal fields stored as `text`.** `exchange_rates.as_of_date` / `last_checked_at`, `inland_route_cache.fetched_at`, and `quote_drafts.date` / `created_at` / `updated_at` are `text` holding ISO strings — no DB-level temporal validation, timezone semantics, or correct ordering (string sort ≠ chrono sort for mixed formats). Contrast: the **audit** `created_at`/`updated_at` columns on the entity tables are correctly `timestamptz`. *Fix:* type the domain date fields as `date`/`timestamptz` in the hardening migration (the app already writes ISO strings, so the cast is mechanical).
- 🟢 String columns are unbounded `text` (no `varchar(n)` caps). Idiomatic in Postgres (no storage/perf cost); only relevant if you want DB-level input-length validation. Not a defect.

#### Schema isolation — 🟢 clean (verified)

- `expressline` is a **real, separate schema**. The other tenants are **`public`-schema, prefix-namespaced tables**: 18 `public.joyas_*` + 11 `public.punas_*` (no `pang_*` tables exist yet). The shared Supabase project (`polxyashvxbzdkkmxuox`) is confirmed.
- **Cross-schema FK check over the whole DB:** the only FKs crossing a schema boundary are `public.punas_* -> auth.users` (6 of them — Supabase Auth, punas's concern). **Zero FKs touch `expressline`** — none out of it, none into it. expressline is FK-isolated. ✅
- **Shared-instance caveat (not a schema defect):** the three tenants share one Postgres instance → shared connection limits, egress, CPU, and storage quota. A broad `postgres` role sees all schemas; isolation for the app is enforced by the restricted `expressline_migrator` role + the `assertProd`/`sandbox-guard` ref checks ([prod-guard.js](../../scripts/relational/prod-guard.js)). This matches the known shared-tenant reality (the egress storm that blew the free tier ~70× was a *shared-quota* incident — see [store/index.js:36](../../src/lib/store/index.js#L36) cache rationale).

#### Legacy / dead structures — 🟢/🟡 three items (m1, m2, m7)

- 🟢 **m1 — `audit_logs` is dead.** Created by the migrator ([db.js:86](../../src/lib/db.js#L86)) with a `bigserial` PK + sequence, but **no code path inserts into it** (verified by grep across `src/` and `scripts/`). It is migration scaffolding for an audit trail that was never wired. 0 rows. *Fix:* wire it (the clear original intent — `audit_logs` has `actor/action/target/before_payload/after_payload`) or drop it + its sequence. An empty `audit_logs` is misleading for anyone assuming an audit trail exists.
- 🟢 **m2 — `quote_snapshots` is write-only.** Written on every generated quote ([workbench.js:374](../../src/routes/workbench.js#L374)); `listQuoteSnapshots` exists ([db.js:206](../../src/lib/db.js#L206)) but has no caller and its PK index has 0 scans. Fine as append-only telemetry, but there is no read/retention path — it will grow unbounded. Decide: surface it (admin view) or add a retention policy.
- 🟢 **m7 — `users` never left the blob.** Auth reads/writes `app_state['users']` ([store/index.js:461-484](../../src/lib/store/index.js#L461)), a 359 B JSON payload — it was **not** migrated to a relational table. Passwords are stored **plaintext** in that payload and compared directly ([core.js:29-31](../../src/routes/core.js#L29)). Out of scope for a structure check, but flagged: the only persistent secret-bearing row is an unmigrated, unhashed blob. (Auth is also not enforced — see PART 2 / ARCHITECTURE.md auth note.)
- 🟢 **m8 — `yard_carriers` empty:** 0 rows while `yard_ports` has 28 → yards are presently scoped **by port only**, not by carrier. The documented rule is "yard options depend on 港口 + 船公司"; the carrier dimension is simply unpopulated in the data (the migrated blob had no `yard.shippingLineIds`). Schema models it correctly; surface to the operator if carrier-scoping is intended.
- 🟢 **m7-legacy — the 1.24 MB retired blob** (`shipping-data-retired-20260625`) is intentionally retained as the rollback anchor (per the cutover runbook). It is dead weight once the rollback window closes; schedule its deletion then.

---

## PART 2 — Architecture Re-check (post-migration, LIGHT)

Scope: only what the migration *added* on top of the closed 2026-06-22 god-file refactor — the relational layer (`lib/db.js` relational functions, `store/index.js` mode switch, `relational-map.js`, `relational-repo.js`). Read-only; graded.

### No god-file regrowth — 🟢

`wc -l` of the migration-touched + largest files:

```
 125  src/server.js              (composition root — was 4707 pre-refactor)
 507  src/lib/db.js              (+ relational fns; single concern: persistence)
 585  src/lib/store/index.js     (store facade + mode switch + cache)
 662  src/lib/store/relational-map.js   (pure decompose/assemble + TABLE_META)
 315  src/lib/store/relational-repo.js  (DDL + idempotent SQL I/O)
1180  src/lib/calculate.js       (pre-existing pure calc leaf)
1037  src/lib/views.js           (view layer)
 943  src/lib/quote.js
```

Nothing regressed into a god-file. The biggest files (`calculate.js`, `views.js`, `quote.js`) are pre-existing single-responsibility leaves, not concern-mixers like the old `server.js`. The migration-added modules are all reasonably sized and single-purpose.

### Layering / dependency direction — 🟡 one reverse edge (M4)

The documented invariant ([ARCHITECTURE.md](../ARCHITECTURE.md), Module boundaries) is **"Single dependency direction: `routes/* → lib/* → lib/store/* → lib/db`. No reverse imports, no cycles."**

The migration **broke the "no reverse imports" half.** Actual require graph of the data layer:

```
store/index.js   → ../db                         (store → db,   expected ✅)
db.js            → ./store/relational-map         (db → store,   REVERSE ⚠)
db.js            → ./store/relational-repo        (db → store,   REVERSE ⚠)
relational-repo  → ./relational-map               (leaf → leaf,  fine)
relational-map   → (nothing — pure leaf)
```

- 🟡 **M4 — `lib/db` imports from `lib/store/`.** `db.js` reaches *up* into `lib/store/` for `relational-map` (pure blob↔table mapping) and `relational-repo` (DDL + SQL helpers). The store and db layers are now **mutually dependent at the layer level.**
- **No runtime cycle:** the specific modules differ — `db.js` does not import `store/index.js`, and `relational-map`/`relational-repo` do not import `db.js` (verified). So Node has no circular-require problem and behavior is unaffected. But the documented "no reverse imports" claim is now **inaccurate**, and the clean "db is the bottom layer" story is muddied.
- **Root cause:** `relational-map.js` and `relational-repo.js` are *logically* db/data-mapping primitives (no store-facade logic — pure mapping + SQL) but were filed *physically* under `lib/store/`. *Fix:* relocate both under `lib/db/` (e.g. `lib/db/relational-map.js`, `lib/db/relational-repo.js`) and update the ~3 require paths in `db.js` + `store/index.js`. This restores `routes→lib→store→db` as strictly downward. Risk-equivalent to the 2026-06-22 pure-move refactor (no behavior change; `test:all` is the safety net).

### Coupling / duplication smells — 🟢 one to watch

- 🟢 **Two sources of schema truth.** The table shape is encoded **twice**: as DDL strings in `relational-repo.js#buildSchemaDDL` and as column/jsonb lists in `relational-map.js#TABLE_META`. A schema change must edit both in lockstep (the DDL adds the column; `TABLE_META.cols`/`jsonb` must match for upsert/read to include it). No single source of truth → drift hazard on the next schema change. Mitigated today by the parity/round-trip gates (`scripts/relational/parity.js`, `audit-relational-roundtrip-test`), which fail loudly on mismatch. Keep them in CI; consider deriving one from the other later.
- 🟢 The `store/index.js` mode switch (`blob` / `relational` / `dual`) is clean — each mode's read/write path is isolated and the relational path delegates to `db.js` → `relational-repo`/`relational-map` without leaking SQL into the facade. The blob↔relational separation is healthy.
- **No new duplication** in the route/lib layers from the migration; the per-entity targeted writes (`saveCarrierEntity`, `saveCustomsYardEntity`, `saveInlandRateEntryEntity`) share the `withTxn` + `preserveSortOrder` helpers rather than copy-pasting transaction boilerplate.

**PART 2 verdict:** architecture is healthy post-migration — no god-file, no runtime cycle, clean mode separation. The one real finding is **M4** (the `db→store` reverse edge), a structural-hygiene fix, not a functional risk.

---

## Appendix — evidence provenance

All findings derive from a single read-only introspection pass (`/tmp/expressline-db-introspect.js`, not committed) issuing only:
- `pg_namespace` / `information_schema.tables` (schema + tenant-table inventory)
- `pg_class` / `information_schema.columns` (relations, columns, types, nullability, defaults)
- `information_schema.table_constraints` + `pg_constraint` (PK/UNIQUE/FK/CHECK, incl. `on update`/`on delete` and `pg_get_constraintdef`)
- `pg_indexes` / `pg_stat_user_indexes` (index defs + usage)
- `pg_total_relation_size` / `pg_column_size` (sizes — **payloads never pulled**)
- `count(*)` on `expressline` tables only

No `joyas_*` / `punas_*` **data** was read (only their constraint metadata, to prove isolation). No DDL was issued. No row was inserted, updated, or deleted. Code-side facts cite `file:line` in the repo.
