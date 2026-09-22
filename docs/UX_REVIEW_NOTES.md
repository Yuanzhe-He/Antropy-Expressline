# UX Review Notes

Project-specific UI/UX feedback, design preferences, interaction notes, and brand-specific UX decisions.

Use this for project-local UX facts.
Reusable UI/UX judgment should also be reflected in `_AI_WORKFLOW/scales/ui-ux/UI_UX_SCALE.md`.

## Entry format

## YYYY-MM-DD - Short title

User feedback:
- ...

Project-specific interpretation:
- ...

Reusable scale candidate:
- ...

Landed in:
- ...

## 2026-05-04 - Compact Workbench And Local Interactions

User feedback / project audit:
- Source: `docs/product-uiux-audit.md`.
- Sales workbench should not waste first-screen space on repeated module switches or large hero-style headers.
- Handover and customs select changes should not trigger full-page submit when the user has not requested calculation.

Project-specific interpretation:
- This is an operations workbench, so prioritize compact information density, clear current selection summaries, and uninterrupted form work.
- True calculation should still submit when the user clicks `立即计算`; local dependency updates should remain local.

Reusable scale candidate:
- Information density and interaction continuity are reusable across projects.

Landed in:
- `_AI_WORKFLOW/scales/ui-ux/UI_UX_SCALE.md`
- `_AI_WORKFLOW/playbooks/ui-ux-review.md`

## 2026-05-06 - Hierarchical Customs Admin Compaction

User feedback:
- On customs admin pages, do not show every shipping line, terminal, or yard as a long flat list by default.
- Collapse each domain into a count summary first, such as `船公司 14 家`, then expand into the next layer.
- For terminal rules, use a nested path: terminal summary, then child site/port layer, then individual detail sections.

Project-specific interpretation:
- Dense admin maintenance pages should reveal structure first and details second.
- Summary rows must include counts or status context so collapsed sections remain operationally useful.
- This is a UI information-architecture change only; it must not change ownership rules such as shipping-line + container-type storage assignments.

Reusable scale candidate:
- Dense admin configuration pages should prefer hierarchical progressive disclosure over flat repeated cards.

Landed in:
- `views/admin-customs.ejs`
- `public/styles.css`
- `src/lib/i18n.js`

## 2026-06-10 - Customs Module Renamed To 港口和码头 In UI

User feedback:
- On the left workbench navigation, rename the `清关` business module label to `港口和码头` (port and terminal).
- Scope was the nav label text only, not a structural / business-logic change.

Project-specific interpretation:
- The label lives in one shared i18n string `modules.customs.title`, so the rename also flows to the customs page heading (`views/workbench-customs.ejs`) and the admin module heading by design; nav and page heading stay consistent.
- The matching Spanish subtitle (`Despacho Aduanal`) was updated to `Puertos y Terminales` in both `zh` and `es` so the nav item is not contradictory (port/terminal label over a "customs clearance" subtitle).

Important divergence to remember:
- This is a display-label change only. The module key, route (`/workbench/customs`, `/admin/customs/*`), data shape, and most internal copy (form labels, admin titles, `清关堆场费`, etc.) are still `customs` / 清关. Future work that searches for a "港口和码头" module/route will not find one — it is still `customs`.

Landed in:
- `src/lib/i18n.js` (`zh.modules.customs.title` + `subtitle`, `es.modules.customs.title` + `subtitle`)

## 2026-06-10 - Customs Admin: Add Port + Reliable Add Terminal

User feedback:
- In the 港口和码头 (customs) admin, you could not add a 码头 (terminal); make it addable.

Investigation:
- Adding a terminal already worked at the route level (`/admin/customs/ports/:portId/terminals/add`, verified by isolated JSON test: Manzanillo 2→3 terminals).
- The real gaps: (1) there was no add-port route/button at all, and (2) the "新增码头" button was nested inside the port `<summary>`, where a submit button toggles the `<details>` instead of submitting — so in the browser it looked like nothing happened.

Project-specific interpretation:
- Mirror the working add-yard pattern: standalone submit buttons placed outside `<summary>`.
- Added `/admin/customs/ports/add` + `buildCustomsPortDraft` (a new port seeds one terminal so it is immediately usable).
- Moved "新增码头" out of the port summary into the port body so it reliably submits.

Landed in:
- `src/server.js` (`buildCustomsPortDraft`, `/admin/customs/ports/add`)
- `src/lib/i18n.js` (`addPort`, `newPortName` — zh + es)
- `views/admin-customs.ejs` (add-port button in section header; add-terminal button moved into port body)

## 2026-06-10 - Unify Customs Container Types With Handover

User feedback:
- The 港口和码头 (customs) module container types should be identical to the 换单 (handover) module's.

Decision:
- The two taxonomies had zero key overlap — handover uses ISO keys (`40GP`, `20GP`, `20FR`, …, 20 types); customs used tariff buckets (`fr-20`, `gp-hc-sd`, `gp-hq-dc`, `imo-dry`, …, 17 types). User confirmed: replace the customs taxonomy with handover's, accepting that per-container customs rates reset (they were sample data; no clean mapping exists).

How it was implemented:
- `normalizeCustomsModuleData` now derives `containerTypes` from the handover module (key + label + order), so customs is always identical to handover.
- All customs rate maps re-key onto handover keys via `ensureRatesForContainerTypes`, which now returns exactly the current container types (preserving matches, dropping stale keys).
- Stale storage rule sets are rebuilt onto the new taxonomy once, gated by a new `containerTaxonomyVersion` (mirrors the existing `storageTierPolicyVersion` migration) so it runs exactly once and never re-triggers (which would otherwise resurrect deleted rule sets). Result: one default storage rule set covering all container types; admins can split it as needed.
- Smoke test updated: linked-workflow keys use `40GP`; because unified types share one default rule set, the storage-assignment release test now sets up its own occupied assignment instead of relying on seed variety.

Data impact:
- On first load after deploy (production Postgres has no `containerTaxonomyVersion`), customs per-container fixed/drop-off/yard rates reset to 0 and storage rule sets collapse to one default; persists on the next save. Re-enter customs rates afterward.

Landed in:
- `src/lib/store.js` (`CUSTOMS_CONTAINER_TAXONOMY_VERSION`, `normalizeCustomsModuleData`, `normalizeStorageRuleSets`, `ensureRatesForContainerTypes`)
- `scripts/smoke-test.js`

## 2026-05-06 - Workbench Home First Screen Compaction

User feedback:
- For `/workbench/handover`, improve the first viewport for sales workbench use.
- Do not expose the `仅放单 / 放单 + 清关` choice in this pass.
- Use the DEWELL logo as the general customer-facing brand; keep Antropy AI secondary.

Project-specific interpretation:
- The mobile sidebar should become a compact workbench header so users reach the quote form faster.
- `立即计算` belongs immediately after the essential quote inputs, before optional tax overrides.
- The hidden `businessNature=handover_only` default remains unchanged so the current handover flow does not change behavior.
- Brand polish can be handled with DEWELL-first header/title/favicon treatment without touching pricing logic.

Reusable scale candidate:
- Workbench first screens should prioritize direct operational progress over navigation chrome.

Landed in:
- `views/workbench.ejs`
- `views/partials/header.ejs`
- `public/styles.css`
- `src/lib/i18n.js`
- `public/favicon.svg`


## 2026-09-13 - Quote setup, fee density and custom fields

Chandler requested early loading-mode selection, clearer fee sections, smaller checkmarks and less empty row height. Quote scope and cargo mode now precede general data, with FCL container rows or LCL/BBK package inputs. Four customs questions have explicit unanswered/unknown values.

Fixed fees and charges-if-incurred have separate tables, editable backend libraries and local template restoration. The current editing language uses one visible concept input; other translations expand on demand. Custom fields say field name/content with examples. Quote-scoped blue-gray surfaces replace the flat black table, and native checkboxes are 16px square. Existing unrelated screens retain their styling.

Verified desktop fee rows around 82px, checkbox16px, mobile390px viewport without page-wide overflow, ES controls, mixed containers, raw kg/cm3 calculations, mode changes with fractional inputs, draft save and category-currency readback. PDF qualifications use wider labels; repeated section headers and margin footers avoid orphan titles and overlaps.


## 2026-09-20 - Four transport workflows and saved output choices

Quote scope and cargo/service type are top-level controls. FCL supports multiple container rows; LCL/BBK/AIR have separate retained state and manual/raw/volumetric pricing methods. AIR begins with manual quantity and no assumed divisor. New fee rows belong to the selected type. Descriptive cargo fields do not force automatic transport pricing. Drafts reopen without losing inactive-mode entries or PDF choices. Customer/internal output, explicit tax treatment and the default-off PDF summary checkbox sit with export controls. Old disabled/removed types may only be reopened through their actual saved draft.

Browser checks: FCL 2×100 + 1×250 = 450; LCL max(10 kg, 12000 cm3) × .01 = 120; BBK manual 387×41 = 15867; AIR manual 120×5 = 600. Switching and reopening retain these separate values. At 1440px the two top selectors share y=313.98 and height=42px. Default narrow viewport stacks controls. Four rendered A4 PDFs were visually inspected, including customer totals off, included-tax 1850 with no added VAT, internal 10-row BBK with codes, and AIR manual pricing.


## 2026-09-22 - Single quote and long-term rate-card switch

Chandler supplied a multi-container price-list screenshot and asked for an independent 单票报价 / 长期报价 choice for FCL, LCL, BBK and AIR. The three top selectors are quote type, geography and cargo type. Long-term editing shows alternative specifications as columns, fixed quantity 1, editable fee rows, units, currency, remarks, ranges and AT COST. Backend presets use the same editor; changing a preset affects newly initialized rate cards only. Single-shipment actual quantities, inactive cargo modes, and PDF summary preferences survive switching and saving.

Verified through the local browser: 40HQ 3×300 plus 20GP 5×250 produces 2150; rate-card prices 100/150/190 save and reopen independently; BBK supports Standard and Special Machinery prices 200/350. Backend 40HQ preset456 applies to a fresh quote while the saved quote retains190. At desktop1280 the three selectors share the same row; at390 they stack and document width375 stays within the viewport. Matrix overflow is contained locally. Versioned asset URLs ensure refreshed pages receive the matching editor/styles.

PDF visual review: one portrait single-quote page, two landscape FCL customer pages, and three landscape BBK internal pages covering four specifications. Prices, quantity1, blank vs zero, ranges, internal-code visibility and continuation tables were checked on every page. Large matrices split into groups of up to three columns; standard clauses remain user-selected.
