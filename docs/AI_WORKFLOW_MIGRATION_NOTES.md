# AI Workflow Migration Notes

Date: 2026-05-04

## Mode

- mode: greenfield
- reason: no existing `AGENTS.md`, `CLAUDE.md`, or `.cursor/rules/project-context.mdc` was found in this project during bootstrap.

## What Was Added

- Added thin project adapters:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `.cursor/rules/project-context.mdc`
- Added repo-local long-term project rules:
  - `docs/AI_AGENT_PROJECT_RULES.md`
- Added project workflow docs:
  - `docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md`
  - `docs/AI_WORKFLOW_MIGRATION_NOTES.md`
  - `docs/LESSONS.md`
  - `docs/ARCHITECTURE.md`
  - `docs/DATABASE_SCHEMA.md`
  - `docs/UX_REVIEW_NOTES.md`
  - `docs/BRAND_NOTES.md`
- Added local scale override file:
  - `.ai/PROJECT_SCALE_OVERRIDES.md`

## Existing Rules Preserved

- Existing docs were preserved:
  - `README.md`
  - `docs/business-process.md`
  - `docs/product-uiux-audit.md`
  - `docs/env-setup.md`
  - `docs/exchange-rate-refresh.md`
  - `docs/bulk-upload-design.md`
- No project-specific adapter rules were deleted because no project adapters existed.
- No business code was modified.

## Extraction Notes

- Project-specific rules were extracted from existing README and docs, not from business code.
- Hot file list is inferred from existing docs and filesystem structure; needs review.
- Active project was inferred from a workspace with multiple project candidates; needs review.
- Direct-main deployment policy was not proven; conservative no-direct-main default remains active until reviewed.

## Sensitive Information Notes

- Existing docs mention environment variable names and placeholder credential formats.
- No raw secret values were read, copied, stored, or printed during this migration.
- Treat real `DATABASE_URL`, `SESSION_SECRET`, Supabase keys, AI keys, cookies, and passwords as sensitive.

## Post-Bootstrap Hardening

- Active project detection policy was hardened in workspace core/SOP:
  - do not use UI/UX seed text, project name similarity, or recent modification time to choose a sibling project.
  - if a workspace root contains multiple sibling project candidates and no clear active project, do not bootstrap a sibling automatically.
  - for this hardening pass, this project remained active because `docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md` already exists here.
- Default automation was clarified:
  - ordinary development tasks use AI Workflow automatically after connection.
  - explicit commands are mode shortcuts, not prerequisites.
  - UI/UX routing and lightweight post-task lesson routing are automatic.
- Needs-review status was refined:
  - active project is resolved for this hardening pass, but the original initial target choice remains user-reviewable.
  - direct-main deploy remains unresolved because existing docs mention GitHub/Railway deploy but not a branch policy.
  - hot files were split into evidence-backed core files and inferred broader admin/ownership boundaries.
  - persistence mode now documents local JSON fallback, temporary Railway Volume fallback, Supabase Postgres production target, and unresolved live deployment mode.
- Source attribution check:
  - prompt-seeded UI/UX feedback remains attributed to `cross-project seed from user prompt`.
  - Jose/Expressline-specific UX observations remain in project UX/brand notes.
