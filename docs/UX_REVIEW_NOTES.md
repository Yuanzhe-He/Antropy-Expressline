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
