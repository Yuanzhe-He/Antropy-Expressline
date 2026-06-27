# AI Agent Project Rules

This file is the long-term repo-local source for project-specific agent rules.

Workspace `_AI_WORKFLOW` is a reusable workflow layer, not a replacement for this file.

During migration, existing `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules/project-context.mdc` may still contain duplicated operational rules. Prefer the more specific project-local rule when conflicts exist.

Do not remove project-specific rules from adapters until their destination is clear and no information is lost.

## Project Profile

Project profile:
- primary: fullstack operations dashboard
- secondary:
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
  - docs/env-setup.md

Notes:
- Hardening pass active project: resolved for this pass because this project already has `docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md`; do not switch to another sibling during post-bootstrap hardening.
- Original bootstrap target selection still needs review because the initial run started from a workspace root with multiple sibling project candidates.
- Source: `package.json` describes a cost calculator and admin portal for shipping line release fees.
- Source: `README.md` describes a logistics cost workbench with `换单 / Liberacion`, `清关 / Despacho`, and `陆运 / Transporte`.

## Required Docs At Task Start

Always read:
- `AGENTS.md`
- `docs/AI_AGENT_PROJECT_RULES.md`
- `.ai/PROJECT_SCALE_OVERRIDES.md`

Read only when relevant:
- UI/UX, layout, interaction, dashboard, or visual work: `../_AI_WORKFLOW/scales/ui-ux/UI_UX_SCALE.md`, `docs/product-uiux-audit.md`, `docs/UX_REVIEW_NOTES.md`, `docs/BRAND_NOTES.md`
- Fee logic, logistics workflow, module behavior, or business rules: `docs/business-process.md`
- DB, seed, migration, persistence, or Railway deployment: `docs/DATABASE_SCHEMA.md`, `docs/env-setup.md`
- Bulk upload, Excel template, or data import: `docs/bulk-upload-design.md`
- Exchange rate behavior: `docs/exchange-rate-refresh.md`
- Lessons and repeated incidents: `docs/LESSONS.md`

## Default AI Workflow Automation

After this project is connected to AI Workflow, ordinary development tasks must use AI Workflow automatically.

The user should not need to say:
- "按 AI Workflow"
- "读取 AI Workflow"
- "完成后复盘"
- "按当前项目规则"

Default behavior after connection:
- identify the active project
- read repo-local project rules first
- read only task-relevant docs / scales / playbooks
- apply project-specific rules before global workflow rules
- classify task domain automatically
- decide whether spec-first is needed
- route useful lessons automatically after the task
- output Task Summary

Explicit commands are only mode shortcuts:
- `接入 AI 工作流` = bootstrap/connect
- `新项目接入 AI 工作流` = greenfield bootstrap
- `老项目接入 AI 工作流` = brownfield connect-only
- `只做 UI/UX 评审` = review only, do not modify code
- `复盘 AI 工作流` = heavier workflow/memory review

## UI/UX Routing

If a task involves UI, UX, layout, landing page, visual design, brand fit, interaction behavior, page refresh, scroll position, tab/filter/modal/pagination behavior, or mobile usability, automatically read:
- `../_AI_WORKFLOW/scales/ui-ux/UI_UX_SCALE.md`
- `docs/UX_REVIEW_NOTES.md` if present
- `docs/BRAND_NOTES.md` if present
- `.ai/PROJECT_SCALE_OVERRIDES.md` if present

The user does not need to say "AI Workflow" for this routing to happen.

The phrase `只做 UI/UX 评审` means:
- review only
- output issue list and recommendations
- do not modify code

It does not mean AI Workflow only applies when the phrase is used.

## Project-Specific Architecture Contracts

- Source: `README.md`; the app is a Node/Express/EJS workbench with frontend pages, admin pages, and server-side routes.
- Source: `README.md`; modules are `handover`, `customs`, and `inland`.
- Source: `docs/business-process.md`; `handover + customs` can form one continuous business flow.
- Source: `docs/bulk-upload-design.md`; Excel is an upload/template tool only, not an application database.
- Source: `docs/product-uiux-audit.md`; UI-only improvements must preserve fee calculation behavior unless the task explicitly changes business logic.
- Source: `docs/product-uiux-audit.md`; local select/filter changes should avoid full-page submits and preserve user context.
- Inferred; needs review: route entrypoints, shared data access, and workbench templates should be treated as high-blast-radius files.

## Data Access Rules

- Source: `README.md`; current prototype data uses `data/shipping-lines.json`.
- Source: `README.md`; the app runs on Supabase Postgres in production (relational store, schema `expressline`); the JSON fallback (`STORAGE_DRIVER=json`) is now used only for tests / local dev, not as a pre-migration production path.
- Source: `docs/env-setup.md`; project DB schema is `expressline` when using Supabase Postgres.
- Source: `docs/env-setup.md`; `db:seed` writes repository seed data into `expressline.app_state`; do not run seed against production without explicit confirmation.
- Source: `docs/bulk-upload-design.md`; do not make Excel a runtime data source.
- Current documented options:
  - local/default prototype data source: `data/shipping-lines.json` and JSON fallback.
  - production target when using DB: Railway + Supabase Postgres with `DATABASE_SCHEMA=expressline`.
  - documented temporary fallback: `STORAGE_DRIVER=json` with `DATA_DIR=/app/runtime-data`; docs say production DB mode should not set `STORAGE_DRIVER=json`.
  - resolved (2026-06-25): the live deployment runs on Supabase Postgres, schema `expressline`, `STORAGE_MODE=relational` (18 relational entity tables); the legacy JSON blob is retired/frozen as a rollback anchor. The app runtime connects as the least-privilege `expressline_app` role (not `postgres`) — see `docs/specs/EL_SECURITY_HARDENING_COMPLETE_20260626.md`.
- Do not print, copy, or persist raw passwords, database URLs, API keys, session secrets, cookies, or tokens.
- Treat `data/users.json` and real environment values as sensitive even when local auth is disabled.

## Auth / Permission Rules

- Source: `README.md`; login is currently temporarily disabled and all visitors can access frontend and admin rule editing.
- Source: `README.md`; this is not suitable for direct production launch without auth and permission work.
- Auth, permission, session, password, or role changes require spec-first unless the task is a tiny diagnostic note.

## Business Invariants

- Source: `docs/business-process.md`; `换单` supports local charges, guarantees, demurrage, invoice restrictions, and demurrage cutoff handling.
- Source: `docs/business-process.md`; `清关` is a one-page workflow including terminal fixed fee, terminal storage, drop-off, and customs yard fee.
- Source: `docs/business-process.md`; yard options depend on `港口 + 船公司`.
- Source: `README.md`; exchange rate refresh uses public USD/MXN sources and can be refreshed manually.
- Inferred; needs review: changes that affect fee formulas, tax handling, exchange rates, or quote totals require regression checks and should be described explicitly in Task Summary.

## Testing Rules

- Source: `package.json`; default smoke test command is `npm test`.
- Source: `package.json`; data normalization command is `npm run build:data`.
- Source: `package.json`; database commands are `npm run db:migrate`, `npm run db:seed`, and `npm run db:check`.
- Source: `package.json`; Excel template generation command is `npm run templates:excel`.
- Source: `docs/product-uiux-audit.md`; UI coverage is currently weaker than backend smoke coverage and should include real browser checks when UI behavior changes.
- Test failure tasks automatically classify infrastructure failure vs product regression.
- For DB-backed changes, separate infrastructure failures from product regressions.
- If the agent fixes a regression caused by its own change, mark `[SELF_CORRECTION]` and route the lesson.

## Hot File Policy

Evidence-backed hot/core files from existing docs:
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

Inferred; needs review:
- broader `views/admin*.ejs` blast radius beyond files already named in `docs/product-uiux-audit.md`
- exact ownership boundaries for server routes, shared store logic, and admin templates

When touching these files, Task Summary must include blast radius:
- affected pages/screens
- affected API endpoints
- affected data model / tables
- affected auth/session/permission behavior
- affected runtime flags/config
- affected tests
- required regression/manual smoke checks

## Spec-First Policy

Write `docs/specs/YYYYMMDD_<feature>_IMPLEMENTATION_SPEC.md` before large, ambiguous, cross-module, data-affecting, auth-affecting, or user-facing workflow changes.

Small bug fixes, copy edits, styles, or narrow UI adjustments can skip a spec, but Task Summary must say why the change was small enough.

## Git Policy

- Never force push.
- Do not modify `.git/` config, remotes, branch protection, or protected-branch settings.
- Default to no direct push to `main` / `master` for mature, production, or shared work.
- Prefer PR / branch workflow for production work.
- Conservative default; needs review if this project intentionally uses direct-main deploy.

## Lesson Routing

- After every task, run a lightweight post-task memory routing check automatically.
- Do not wait for the user to ask for a retrospective.
- Classify whether the task produced a project-specific lesson, AI self-correction, user feedback, UI/UX scale update, cross-project engineering candidate, or no durable lesson.
- Every task must end with the visible `Post-task routing` block in `Task Summary Requirements`.
- If nothing durable was learned, the block must still explain the no-op reason instead of ending with only `Durable lesson captured: none`.
- Project facts go to project docs.
- Project-specific lessons go to `docs/LESSONS.md`.
- Potentially reusable UI/UX feedback can also go to `../_AI_WORKFLOW/memory/FEEDBACK_LOG.md`.
- AI self-corrections go to `docs/LESSONS.md` and, if reusable, `../_AI_WORKFLOW/memory/SELF_CORRECTIONS.md`.
- Global UI/UX provisional rules go to `../_AI_WORKFLOW/scales/ui-ux/UI_UX_SCALE.md` and require a source entry in `../_AI_WORKFLOW/memory/FEEDBACK_LOG.md`.
- Cross-project engineering lessons go first to `../_AI_WORKFLOW/memory/LESSON_CANDIDATES.md`.
- Do not silently promote engineering lessons into workspace core rules.

## Task Summary Requirements

End each task with:
- what changed
- files changed
- tests or checks run
- business code modified: yes/no
- secrets exposed: no
- lessons routed, if any
- `[INCIDENTAL_FIX]` or `[OUT_OF_SCOPE]` markers when applicable
- blast radius when hot/core files are touched

Then include this exact closeout block:

```md
## Post-task routing

- Project fact updated:
- Project lesson:
- User feedback captured:
- UI/UX note updated:
- Brand note updated:
- Self-correction:
- Global candidate:
- Skill/playbook candidate:
- Durable lesson captured:
- If none, reason:
```

Do not omit the block. If there is no durable lesson, write that in `Durable lesson captured:` and explain why in `If none, reason:`.

## Short Command Aliases

- `接入 AI 工作流`: detect workspace root, wrapper, active project, and greenfield/brownfield mode; create or update minimal `_AI_WORKFLOW/`; create or update repo-local AI agent rules; do not modify business code; output `docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md`.
- `新项目接入 AI 工作流`: use greenfield defaults; create thin adapters, docs skeleton, `.ai/PROJECT_SCALE_OVERRIDES.md`, and workspace workflow links; do not create empty playbooks; do not modify business code.
- `老项目接入 AI 工作流`: use brownfield connect-only; preserve existing `AGENTS.md`, `CLAUDE.md`, and Cursor rules; append workspace workflow references; extract project hard rules into `docs/AI_AGENT_PROJECT_RULES.md`; write migration notes and final report.
- `brownfield connect-only 接入 AI 工作流`: same as `老项目接入 AI 工作流`.
- `只做 UI/UX 评审`: review UI/UX only; output issue list and recommendations; do not modify code.
- `复盘 AI 工作流`: review `docs/LESSONS.md`, workspace feedback log, self-corrections, and lesson candidates; classify what stays local, what is a global candidate, what can become a playbook, what can update UI/UX scale, and what should not be promoted.
- `按 AI Workflow 做 UI/UX review`: use global UI/UX scale, project UX notes, brand notes, and project scale overrides; if the user says "只评审，不改代码", output findings only and do not modify business code.
