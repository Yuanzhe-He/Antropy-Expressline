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

## 2026-06-10 - Deferred: Unify Customs Container Types With Handover

User feedback:
- The 港口和码头 (customs) module container types should match the 换单 (handover) module's.

Why deferred (not shipped):
- Handover uses ISO container keys (`40GP`, `20GP`, `20FR`, …, 20 types); customs uses a separate tariff taxonomy (`fr-20`, `gp-hc-sd`, `gp-hq-dc`, `imo-dry`, …, 17 types). There is no clean key mapping.
- Every customs rate map (terminal fixed charges, yard drop-off/customs charges, storage rule-set assignments) is keyed by the customs taxonomy. Re-keying to handover keys resets all per-container rates to defaults and collapses the per-container storage rule-set structure.
- Local JSON rates are sample data, but production runs on Postgres whose real customs config is not visible here; unifying would silently reset it on the next load.

Decision needed before implementing:
- Confirm it is acceptable to reset customs per-container rates / storage assignments, then implement cleanly (sync container types + regenerate customs rate structure around handover types + make the storage-assignment smoke test set up its own occupied assignment instead of relying on seed variety).

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
