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

- Current prototype source: `data/shipping-lines.json`.
- Current documented options:
  - local/default prototype data source: `data/shipping-lines.json`.
  - production target when using DB: Railway + Supabase Postgres.
  - documented temporary fallback: JSON storage with Railway Volume at `/app/runtime-data`.
  - unresolved: which persistence mode the current live deployment is actually using.
- Excel templates are not runtime data sources.
- Source: `README.md`, `docs/env-setup.md`, `docs/bulk-upload-design.md`.

## Auth / permissions

- Current login entry is temporarily disabled.
- All visitors can access frontend and admin rule editing.
- Not suitable for production without auth and permission hardening.
- Source: `README.md`.

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
