# Architecture

## Project summary

- Logistics cost operations workbench for `换单 / Liberacion`, `清关 / Despacho`, and `陆运 / Transporte`.
- Source: `README.md`.

## Project profile

- labels:
  - fullstack
  - frontend
  - dashboard
  - backend
  - database
- confidence: medium
- inferred_from:
  - package.json
  - README.md
  - docs/business-process.md
  - docs/product-uiux-audit.md

## Main surfaces

- Sales/operator workbench for quote calculation.
- Admin pages for module settings, handover rules, customs rules, exchange-rate status, and bulk upload templates.
- Source: `README.md`.

## Data model / persistence

- **Production runs on Supabase Postgres, schema `expressline`, `STORAGE_MODE=relational`** — the app reads/writes **18 relational entity tables**, assembled in-process into the shipping-data shape. The blob→relational migration is **closed** (2026-06-25); the legacy `app_state.shipping-data` JSON blob is **retired** (frozen as a rollback anchor). The "unresolved JSON vs Supabase" question is settled: relational is live.
- Schema inventory: 18 relational tables + 3 carry-over tables (`app_state` = retired blob + live `users` row; `quote_snapshots` = write-only quote audit; `audit_logs` = dead/unused) + 2 sequences. Full map: [docs/DATABASE_SCHEMA.md](DATABASE_SCHEMA.md); structure health check (no Critical defects): [docs/specs/20260625_db_structure_health_check_REPORT.md](specs/20260625_db_structure_health_check_REPORT.md).
- Persistence selection: Postgres when `DATABASE_URL` is set (`STORAGE_DRIVER=json` forces the local JSON fallback for tests/dev). `STORAGE_MODE` (`blob`|`relational`|`dual`) picks the DB backend; prod is `relational` ([src/lib/store/index.js](../src/lib/store/index.js#L224)).
- Reads go through an in-process cache (~1h TTL, write-through) over `getShippingTablesAssembled` — the egress guard after the shared-tenant free-tier egress storm. Writes are targeted per-entity / per-module transactions, not full-table overwrites.
- Shared Supabase project `polxyashvxbzdkkmxuox` (with `public.joyas_*` / `public.punas_*`); `expressline` is FK-isolated (zero cross-schema foreign keys). Excel templates are not runtime data sources.
- Source: live PROD introspection 2026-06-25, `src/lib/db/index.js`, `src/lib/store/index.js`, `docs/MIGRATION_COMPLETE_20260625.md`.

## Auth / permissions

- **Login is not enforced.** `attachUser` and `requireAuth` both assign every visitor the frozen `publicDemoUser` (role `admin`) — all visitors can access frontend and admin rule editing ([src/middleware/auth.js](../src/middleware/auth.js)). The two names are kept distinct so re-enabling real auth later only touches `requireAuth`.
- A real `POST /login` path exists (checks username/password against `getUsers()` and sets `session.user`, [src/routes/core.js:26](../src/routes/core.js#L26)) but nothing rejects unauthenticated requests, so it is currently inert.
- **Auth data was not migrated:** users live in `app_state['users']` (the legacy blob table, 359 B), **not** a relational table, and **passwords are stored plaintext**. Security debt — out of scope for the structure work but tracked in the health check (m6/m7).
- Not suitable for production without auth + permission hardening and password hashing.
- Source: `src/middleware/auth.js`, `src/routes/core.js`, `src/lib/store/index.js` (verified 2026-06-25).

## Key modules

- `handover`
- `customs`
- `inland`
- exchange rate refresh
- bulk upload template generation
- Inferred; needs review: exact ownership boundaries should be confirmed against source files before large changes.

## Known hot files

- Evidence-backed from current docs:
  - `src/server.js`
  - `src/lib/store.js`
  - `public/calculator.js`
  - `public/styles.css`
  - `views/workbench.ejs`
  - `views/workbench-customs.ejs`
  - `data/shipping-lines.json`
  - `scripts/db-migrate.js`
  - `scripts/db-seed.js`
  - `scripts/refresh-exchange-rates.js`
- Inferred; needs review:
  - broader `views/admin*.ejs` blast radius beyond specific admin templates cited in `docs/product-uiux-audit.md`
  - exact ownership boundaries for route, store, and admin-template changes

## Module boundaries (post god-file refactor, 2026-06-22)

`src/server.js` (was ~4707 lines mixing routes + helpers + view-prep) and
`src/lib/store.js` (~2606 lines) were decomposed into a layered structure.
**Single dependency direction: `routes/* → lib/* → lib/store/* → lib/db`.**
No reverse imports, no cycles. The refactor was a pure move (zero behavior change;
`npm run test:all` 14/14 and `quote-test` 9/9 byte-identical throughout).

> **Update (2026-06-25) — M4 reverse edge RESOLVED.** The blob→relational migration had
> introduced one reverse layer edge (`lib/db.js` imported `lib/store/relational-{map,repo}`).
> This was fixed by converting `lib/db.js` → `lib/db/index.js` and **co-locating the two
> pure mapping/DDL leaves as `lib/db/relational-map.js` + `lib/db/relational-repo.js`**.
> The dependency direction is clean again: `store/index.js → db/* (index + relational-repo)`
> is the only `store→db` edge, and `db/` imports only its own leaves (plus the shared
> bottom leaves `env` / `usage-guard`, which the store layer also imports). **No reverse
> imports, no cycles** — verified, `npm run test:all` 20/20. See finding **M4** +
> remediation in [docs/specs/20260625_db_remediation_DECISIONS.md](specs/20260625_db_remediation_DECISIONS.md).

### Composition root
- `src/server.js` (~107 lines) — `createApp()` wires Express + middleware + the
  route modules and returns the app; the bottom guard starts the listener + FX
  scheduler. It builds one shared `ctx` (the `lib/views` module + `buildRuleId`,
  `buildHandoverFormData`, `requireAuth`) and passes it to each route module's
  `register(app, ctx)`. Registration order is matching-sensitive: customs-specific
  `/admin/customs/shipping-lines` registers before the generic
  `/admin/:moduleKey/shipping-lines`.

### HTTP layer — `src/routes/` (public API: `register(app, ctx)`)
- `core.js` — `/`, `/login`, `/logout`, `/preferences/language`.
- `health.js` — `GET /healthz`.
- `exchange-rates.js` — `POST /admin/:moduleKey/exchange-rates/refresh` (+ the
  refresh-monitor trap).
- `workbench.js` — per-module calculators + the quote builder/PDF.
- `admin-inland.js` — inland admin (origins/destinations/precise-points/
  rate-entries + route-cache refresh/override; owns the `markRouteStale` /
  `refreshOneInlandRoute` closures).
- `admin-customs.js` — customs admin (ports/terminals/yards, fixed charges,
  storage rule-set engine, assignment release, bulk save; owns
  `removeCustomsStorageAssignment`).
- `admin-shipping-lines.js` — `/admin/:moduleKey/shipping-lines*` (list/edit,
  local-charges / terminal-mix / demurrage sub-resources, add/delete + the big
  per-line edit handler with customs-mirror sync).
- `admin-handover.js` — container-type master CRUD.
- `admin-settings.js` — `/admin` + per-module settings (incl. the quote
  remarks/notes library).

### Logic + view layer — `src/lib/`
- `rule-engine.js` — progressive rate-rule engine + shared form/rate-cell
  primitives (`buildRuleId`, `appendProgressiveRule`, `resequenceRules`,
  `removeProgressiveRule`, `applySequentialRuleUpdates`, `applyRateCellUpdates`,
  `upsertRateCell`, `ensureArray`, `uniqueIds`, …). Imports only `calculate` + `store`.
- `customs-rules.js` — customs draft builders + storage-rule-set assignment sync.
  Imports `rule-engine`.
- `handover-forms.js` — shipping-line / local-charge / terminal-mix drafts, the
  customs mirror, handover calculator form-data. Imports `rule-engine`.
- `views.js` — server-side view layer: `baseView`, the `render*` helpers, the
  workbench/admin form-data + tax/dependency builders, the inland map, and the
  quote view builders, plus the shared accessors `getModuleData` /
  `loadShippingData` / `redirectWithFlash`.
- pre-existing leaves: `calculate`, `quote`, `quote-pdf`, `i18n`, `modules`,
  `options`, `inland-*`, `usage-guard`, `refresh-monitor`, `exchange-rate-scheduler`.

### Middleware — `src/middleware/`
- `auth.js` (publicDemoUser/attachUser/requireAuth), `i18n.js` (language
  negotiation), `locals.js` (XSS-safe `safeJson` + flash). Wired in a fixed order:
  urlencoded → static → session → language → user → safeJson → flash.

### Data layer — `src/lib/store/` (public API identical to the old `store.js`)
- `shared.js` — rate-group consts + cross-cutting normalization primitives
  (charge/rate/container-type/id/rule-list). Leaf (imports no store siblings).
- `normalize-handover.js` / `normalize-customs.js` / `normalize-inland.js` /
  `normalize-quote.js` — per-entity normalizers; import `shared` only.
- `normalize-shipping-data.js` — top-level composer (`normalizeShippingData` /
  `normalizeModules`); imports `shared` + the four module normalizers.
- `index.js` — public entry: persistence (JSON / Postgres via `lib/db`) +
  in-process read cache + targeted writes. Re-exports the unchanged public API
  (`getShippingData`/`saveShippingData`/`saveExchangeRates`/`getUsers`/`saveUsers`/
  `normalizeShippingData`/`formatDemurrageRuleLabel`/`parseDemurrageRange`/
  `localizedInlandName`/`invalidateShippingDataCache`/`RATE_GROUP_NAMES`).
- The entity division (handover / customs / inland / quote / top-level) is
  forward-compatible with a future blob→relational repository split.

### Test net — `npm run test:all` (`scripts/run-all-tests.js`)
- 14 JSON-mode in-process suites (real `createApp()` over HTTP, isolated temp
  `DATA_DIR`, never touches repo `data/` or production). `audit-admin-routes-test`
  and `audit-admin-deep-test` give every admin write route route-level coverage so
  a bad pure-move turns red.

### Honest scope note
- This was a **code-structure** refactor only: no behavior change, no DB schema
  change, zero production contact. Decoupling does **not** reduce egress (that is a
  data-layer concern); the blob→relational data migration is a separate task.

## Notes

- This file contains project facts, not global workflow rules.
