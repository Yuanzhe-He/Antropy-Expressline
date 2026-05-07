# Project Lessons

Project-specific lessons, incidents, and reusable observations.

Do not use this as a daily changelog.
Only record lessons that may change future behavior.

## Entry format

## YYYY-MM-DD - Short title

- source_type: project-incident | ai-self-correction | user-feedback | test-failure
- task_type:
- domain:
- trigger:
- incident_or_feedback:
- lesson:
- scope: project | project-type | global-candidate
- landed_in:
- next_action:

## 2026-05-05 - Avoid Per-Option Admin Release Buttons

- source_type: ai-self-correction
- task_type: implementation
- domain: customs admin UI
- trigger: adding release controls for occupied shipping-line / container-type storage assignments.
- incident_or_feedback: the first implementation rendered one release button per occupied option and expanded the admin HTML payload to about 22 MB.
- lesson: for dense assignment matrices, avoid duplicating large option lists into secondary controls; render one compact control per card and derive its choices client-side from existing disabled options.
- scope: project
- landed_in: views/admin-customs.ejs, public/app.js
- next_action: when changing large admin matrix UIs, include a quick rendered HTML size or DOM-volume check before finalizing.

## 2026-05-06 - Persisted Defaults Need Migration

- source_type: user-feedback
- task_type: implementation
- domain: customs storage rules
- trigger: user reported that production still showed the old third storage tier after the default was changed to two tiers.
- incident_or_feedback: changing seed/default builders did not remove legacy persisted DB/runtime JSON state.
- lesson: when changing default rule structure, add a versioned normalization or migration path for existing persisted data, not just new drafts and repository seed JSON.
- scope: project
- landed_in: src/lib/store.js
- next_action: for future data-shape defaults, test against a fixture that simulates the old persisted shape.

## 2026-05-06 - Shared Mobile Chrome Must Check Admin In Spanish

- source_type: ai-self-correction
- task_type: implementation
- domain: workbench/admin responsive UI
- trigger: compacting the shared sidebar/header for the handover workbench.
- incident_or_feedback: browser regression found the Spanish `/admin/handover/settings` page had horizontal overflow because admin cards and tables could force a wider grid item.
- lesson: shared mobile chrome changes need admin-page checks in both supported languages, and grid/card wrappers should use `min-width: 0` so table overflow stays inside table cards instead of widening the page.
- scope: project
- landed_in: public/styles.css
- next_action: include Spanish mobile admin overflow checks when changing shared sidebar, header, cards, or grid wrappers.
