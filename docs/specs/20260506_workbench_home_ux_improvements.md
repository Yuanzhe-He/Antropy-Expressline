# Workbench Home UX Improvements Spec

Date: 2026-05-06

## Scope

Improve the first-screen experience of `/workbench/handover` as a sales operations workbench.

This spec is based on the 2026-05-06 UI/UX review findings:

- mobile sidebar consumes too much of the first viewport before the handover workbench appears
- desktop primary calculation action is too far below the first screen
- Express Line / DEWELL GROUP / Antropy AI / Jose Expressline naming hierarchy is unclear
- favicon request currently returns 404 and basic brand polish is incomplete

## Non-Goals

- Do not change backend route behavior.
- Do not change calculator formulas, tax handling, exchange-rate behavior, linked-workflow storage, or quote totals.
- Do not change persistence, JSON data shape, database schema, migrations, seed scripts, or DB configuration.
- Do not add auth, roles, quote persistence, export, or customer-facing quote documents.
- Do not convert `/` into a separate marketing landing page in this pass; `/` may continue redirecting to `/workbench/handover`.
- Do not expose, redesign, or change the `仅放单 / 放单 + 清关` business-nature choice in this pass.

## Hardened Decisions After Review

These decisions remove ambiguity before implementation:

- Leave the current handover business nature behavior alone. The hidden `businessNature=handover_only` field should stay hidden and unchanged in this pass.
- Use one primary `立即计算` action in the main flow, placed immediately after the essential quoting inputs.
- Do not ship two equal primary calculate buttons. If a lower-page action remains, it must be secondary and clearly different, but the preferred implementation is one primary action only.
- Move tax override controls under the primary action as an advanced section. Keep changed tax choices visible with a compact status marker if the section is collapsed.
- Use the DEWELL logo as the primary general brand mark for this app surface.
- Keep `Antropy AI` secondary; it can remain as the creator/technology mark, but it should not visually compete with DEWELL in the first viewport.
- Treat `Express Line` as a product/workbench label, not the primary brand mark.
- Use a lightweight DEWELL-based favicon so the browser tab feels branded without needing a broader brand redesign.
- Because the sidebar/header is shared with admin pages, mobile validation must include an admin page, not only `/workbench/handover`.

## Business Logic Safety Line

This plan must stay on the surface layer:

- The hidden handover value stays as `businessNature=handover_only`.
- The form still submits to the same `/workbench/handover` path.
- The calculate button still uses the existing `data-calculate-submit` behavior.
- Tax controls can move visually, but their submitted names and values must stay the same.
- No changes to quote math, fee rules, exchange rates, session restore, store, data JSON, migrations, or database schema.

## Concrete Operator Story

After this plan lands, a sales user opening `/workbench/handover` should experience this:

1. On a phone, the first screen does not get swallowed by the left navigation. The user sees the DEWELL brand, the current module, and the start of the quote form quickly.
2. The user chooses the shipping line, BL count, currency, container rows, and demurrage days.
3. Before scrolling into optional tax details, the user sees one clear `立即计算` button.
4. Optional tax details are still available, but they no longer block the main quote action.
5. The page feels like a logistics sales workbench under the DEWELL brand mark, with Antropy AI kept secondary.
6. The browser tab has a small DEWELL-based favicon instead of a missing-icon request.

## Proposed Changes

### 1. Mobile sidebar compaction

Type:
- Pure UI / responsive layout.

Goal:
- On mobile, the user should see the current workbench title and at least the start of handover inputs within the first viewport.
- The sidebar should remain available but should not occupy most of the mobile first screen.

Expected approach:
- At small breakpoints, convert the left sidebar from a full stacked panel into a compact top workbench header.
- Keep the brand visible but reduce logo block height.
- Make workspace navigation compact and horizontally scannable, or show only the current module plus a compact module switcher.
- De-emphasize or collapse the user card on mobile.
- Keep management/admin entry reachable without letting it dominate the first viewport.

Likely files:
- `public/styles.css`
- `views/partials/header.ejs` only if existing markup cannot support the compact state cleanly

Do not modify:
- `src/server.js`
- `src/lib/calculate.js`
- `src/lib/store.js`
- `data/shipping-lines.json`

Risks:
- Hiding admin/user controls too aggressively could make management access hard to find.
- Horizontal nav can create overflow or clipped text in Chinese/Spanish.
- A CSS-only change could affect admin pages because the sidebar partial is shared.

Validation:
- Browser check at `390x844`: workbench title and some input context should be visible in the first viewport.
- Browser check at `430x932`: sidebar/header should not exceed roughly one third of the first viewport.
- Confirm workspace links still navigate to `放单`, `清关`, and `陆运`.
- Confirm admin link remains accessible on mobile.
- Browser check at `390x844`: `/admin/handover/settings` still shows admin tabs and table/form content without the compact header breaking the admin layout.
- Confirm desktop sidebar behavior is unchanged at `1440x900`.

### 2. Bring `立即计算` into the primary workflow path

Type:
- Mostly UI / template layout.
- Possible business-flow impact because the submit affordance controls when calculation occurs.

Goal:
- Sales should not need to scroll past optional tax override controls before seeing the primary calculate action.
- The main action should remain tied to the existing POST/fetch calculation flow.

Expected approach:
- Keep the essential input order: shipping line, BL count, price mode, quote currency, container rows, demurrage days.
- Put one primary calculate button immediately after the essential input group.
- Move optional tax overrides below the main action as an advanced section.
- Prefer removing the existing bottom primary calculate button instead of duplicating the action.
- If a lower-page action is retained for long-form convenience, it must be visually secondary and must use clearly different copy from the primary action.
- The primary calculate button must use the same existing `data-calculate-submit` behavior.

Likely files:
- `views/workbench.ejs`
- `public/styles.css`
- `src/lib/i18n.js` only if new labels are needed

Do not modify:
- `src/server.js`
- `src/lib/calculate.js`
- `public/app.js` unless a UI-only submit affordance cannot reuse the existing behavior

Risks:
- Moving tax overrides below the action could make tax exceptions less visible.
- Collapsing tax controls could hide important exceptions unless changed-state badges remain visible.
- Removing the lower calculate action could make very long advanced edits feel less convenient, so the advanced section should stay compact.

Validation:
- Desktop `1440x900`: `立即计算` should be visible in or near the first screen after essential inputs.
- Mobile `390x844`: after compacting the sidebar, the user should reach the primary calculate action with substantially less scrolling than today.
- Click `立即计算` and confirm URL stays `/workbench/handover`.
- Confirm the result panel updates through the existing async result replacement.
- Confirm changed tax overrides are still submitted and reflected in result totals.

### 3. Clarify brand and naming hierarchy

Type:
- Pure UI / copy / brand system.

Goal:
- The first screen should feel like a DEWELL-branded logistics workbench.
- `DEWELL GROUP` is the primary visible brand mark.
- `Antropy AI` is secondary and should not compete with DEWELL in the first viewport.
- `Express Line` can remain as the product/workbench label where helpful.
- `Jose Expressline Consulting` is the repository/project name and should not compete with product UI naming.

Expected approach:
- Use the existing DEWELL logo as the primary brand mark in the sidebar/topbar.
- Keep `Antropy AI` small and secondary if shown.
- Do not add `Powered by Antropy AI` as a new claim in this pass.
- Avoid showing four names with equal visual weight.
- Browser title should use a clear DEWELL or workbench pattern, for example `放单 | DEWELL Workbench`.

Likely files:
- `views/partials/header.ejs`
- `src/lib/i18n.js`
- `public/styles.css`
- possibly `docs/BRAND_NOTES.md` after implementation if the naming decision is confirmed

Do not modify:
- backend routing
- data model
- auth/session behavior

Risks:
- Copy changes can affect Chinese/Spanish consistency.
- Making Antropy AI too prominent could make the customer-facing brand feel split.
- Removing existing product wording too aggressively could make the workbench name less recognizable.

Validation:
- First viewport clearly shows one primary brand mark: DEWELL.
- Logo alt text remains accurate.
- Chinese and Spanish titles remain readable on desktop and mobile.
- Page titles remain clear in browser tabs.
- The first viewport does not give `DEWELL`, `Antropy AI`, `Express Line`, and `Jose Expressline Consulting` equal visual weight.

### 4. Favicon and basic brand polish

Type:
- Pure static asset / UI polish.

Goal:
- Remove the current favicon 404 and make the app feel less like a local prototype.

Expected approach:
- Add a small favicon asset, preferably `public/favicon.svg`, using a simplified DEWELL mark.
- Add an explicit favicon `<link>` in `views/partials/header.ejs`.
- Keep asset lightweight and non-secret.
- Do not change static middleware or backend route handling.
- If the full DEWELL logo is too detailed at tab size, use a simplified DEWELL-derived mark rather than switching to an unrelated symbol.

Likely files:
- `public/favicon.svg` or `public/favicon.ico`
- `views/partials/header.ejs`

Do not modify:
- `src/server.js`
- deployment config

Risks:
- Reusing the full DEWELL logo may not be visually legible at small sizes.
- The favicon should not introduce a new symbol that users do not recognize.

Validation:
- Browser dev console no longer reports `GET /favicon.ico 404` or equivalent favicon 404.
- Browser tab shows a favicon on refresh.
- Asset loads in both dark and light theme contexts.

## File Impact Summary

Expected implementation files:

- `views/workbench.ejs`
- `views/partials/header.ejs`
- `public/styles.css`
- `src/lib/i18n.js`
- `public/favicon.svg` or `public/favicon.ico`

Files to avoid in this implementation:

- `src/server.js`
- `src/lib/calculate.js`
- `src/lib/store.js`
- `src/lib/db.js`
- `data/shipping-lines.json`
- `data/users.json`
- `scripts/db-migrate.js`
- `scripts/db-seed.js`
- database migrations or schema docs, unless only documenting that no DB change is needed

## Business Impact Classification

Pure UI / copy:

- mobile sidebar compaction
- brand hierarchy copy
- browser title polish
- favicon
- visual spacing, nav density, and responsive layout

UI with possible business-flow impact:

- moving `立即计算`
- changing tax override visibility/order

Business-flow items explicitly deferred:

- visible `仅放单 / 放单 + 清关` selection

Business logic changes:

- none intended

Database changes:

- none intended

Backend logic changes:

- none intended

## Validation Plan

Static checks:

- `git diff --check`
- inspect changed files to confirm no backend, store, data, migration, or DB files changed

Browser checks:

- Desktop `1440x900`: first screen shows product/workbench identity, shipping-line context, essential inputs, and a reachable primary calculate action.
- Mobile `390x844`: sidebar/header no longer consumes most of the first viewport.
- Mobile `430x932`: current module and first input context are visible without excessive scrolling.
- Mobile `390x844`: `/admin/handover/settings` admin tabs and table/form content remain usable after shared sidebar/header compaction.
- Switch shipping line: no full page reload, no scroll reset, dependent metadata still updates.
- Add/remove container row: viewport remains stable.
- Calculate default handover quote: URL remains `/workbench/handover`, result panel updates.
- Toggle Chinese/Spanish: compact header and calculate action remain readable.
- Confirm the handover page still submits the existing hidden `businessNature=handover_only` value.
- Refresh page: favicon loads without console 404.

Regression checks:

- `npm test`
- `npm run build:data` only if implementation touches data normalization inputs or generated data expectations; otherwise not required for a pure UI/copy patch

## Documentation Updates After Implementation

Update `docs/UX_REVIEW_NOTES.md` after implementation:

- yes, if the mobile sidebar or primary action placement changes land
- record this as a project-specific UX decision for the sales workbench

Update `docs/product-uiux-audit.md` after implementation:

- yes, add a short landed-record section if the implementation is completed
- include code evidence for the compact mobile header, primary calculate placement, DEWELL brand treatment, and favicon

Update `docs/BRAND_NOTES.md` after implementation:

- yes, if the DEWELL-first brand treatment is reflected in UI copy or assets
- record that Antropy AI should remain secondary in the first viewport for this workbench surface

Do not update workflow scale/playbook for this implementation unless the user gives new reusable feedback beyond the existing information-density, interaction-continuity, landing-clarity, and brand-fit rules.
