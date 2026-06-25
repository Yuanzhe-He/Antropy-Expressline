# AI Workflow Bootstrap Report

## 1. Result

- status: needs-review
- mode: greenfield
- business code modified: no
- secrets exposed: no
- sibling projects modified: no
- existing project-specific rules deleted: no
- random migration notes created: no

## 2. Active project detection

- workspace root: `/Users/yuanzhehe/Desktop/Cursor Project`
- wrapper directory: none
- active project: `/Users/yuanzhehe/Desktop/Cursor Project/Jose Expressline Consulting`
- confidence: medium
- inferred assumptions:
  - Workspace root contains multiple repo candidates.
  - Historical bootstrap inference, superseded by the post-bootstrap hardening policy in section 16: `Jose Expressline Consulting` was selected because it is a direct repo under the workspace, was recently modified, and matches the Express Line UI/UX seed in the workflow request.
  - Project mode is greenfield for AI workflow because no project `AGENTS.md`, `CLAUDE.md`, or `.cursor/rules/project-context.mdc` existed before this pass.
- needs review:
  - Confirm that `Jose Expressline Consulting` was the intended active project.
  - Confirm whether production intentionally uses direct-main deploy.
  - Confirm inferred hot files.

## 3. Files created or updated

### Workspace

- `AGENTS.md`
- `CLAUDE.md`
- `_AI_WORKFLOW/core/AGENTS.md`
- `_AI_WORKFLOW/SOP/NEW_PROJECT_BOOTSTRAP.md`
- `_AI_WORKFLOW/SOP/LESSON_ROUTING.md`
- `_AI_WORKFLOW/SOP/SCALE_LIFECYCLE.md`
- `_AI_WORKFLOW/scales/ui-ux/UI_UX_SCALE.md`
- `_AI_WORKFLOW/playbooks/README.md`
- `_AI_WORKFLOW/playbooks/ui-ux-review.md`
- `_AI_WORKFLOW/memory/FEEDBACK_LOG.md`
- `_AI_WORKFLOW/memory/SELF_CORRECTIONS.md`
- `_AI_WORKFLOW/memory/LESSON_CANDIDATES.md`
- `_AI_WORKFLOW/memory/LESSONS.md`
- `_AI_WORKFLOW/templates/shared/AGENTS.md.template`
- `_AI_WORKFLOW/templates/shared/CLAUDE.md.template`
- `_AI_WORKFLOW/templates/shared/project-context.mdc.template`
- `_AI_WORKFLOW/templates/shared/PROJECT_SCALE_OVERRIDES.md.template`
- `_AI_WORKFLOW/MIGRATION_NOTES.md`

### Wrapper adapters

- none

### Active project

- `AGENTS.md`
- `CLAUDE.md`
- `.cursor/rules/project-context.mdc`
- `.ai/PROJECT_SCALE_OVERRIDES.md`
- `docs/AI_AGENT_PROJECT_RULES.md`
- `docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md`
- `docs/AI_WORKFLOW_MIGRATION_NOTES.md`
- `docs/LESSONS.md`
- `docs/ARCHITECTURE.md`
- `docs/DATABASE_SCHEMA.md`
- `docs/UX_REVIEW_NOTES.md`
- `docs/BRAND_NOTES.md`

## 4. Existing rules preserved

- Existing project docs were preserved.
- No existing project adapters were replaced or thinned because none existed.
- No business code was touched.

## 5. Project-specific rules copied into docs/AI_AGENT_PROJECT_RULES.md

- Logistics module boundaries from `README.md` and `docs/business-process.md`.
- Excel is not a runtime data source from `docs/bulk-upload-design.md`.
- JSON fallback and Supabase Postgres policy from `README.md` and `docs/env-setup.md`.
- `DATABASE_SCHEMA=expressline` and seed caution from `docs/env-setup.md`.
- Login/permission disabled status from `README.md`.
- Compact workbench and local-interaction behavior from `docs/product-uiux-audit.md`.
- Hot file policy was inferred from docs and filesystem structure and marked `Inferred; needs review`.

## 6. Command aliases installed

- 接入 AI 工作流: bootstrap/connect workflow for the current project.
- 新项目接入 AI 工作流: greenfield bootstrap.
- 老项目接入 AI 工作流: brownfield connect-only.
- 复盘 AI 工作流: review memory and lesson candidates.
- 日常开发自动行为: read project rules and only task-relevant workflow docs, then route useful lessons after the task.

## 7. Daily automation now expected

- task routing: active project rules first, task-relevant docs only.
- UI/UX routing: global UI/UX scale + project UX notes + brand notes + scale overrides.
- testing routing: classify infra failure vs product regression and route lessons when useful.
- lesson routing: project facts stay local, reusable feedback goes to workspace memory.
- self-correction routing: mark `[SELF_CORRECTION]` and record if reusable.

## 8. Docs / scales / playbooks created

- One global UI/UX scale: `_AI_WORKFLOW/scales/ui-ux/UI_UX_SCALE.md`.
- One non-empty playbook: `_AI_WORKFLOW/playbooks/ui-ux-review.md`.
- Project docs for agent rules, architecture, DB schema, UX notes, brand notes, lessons, migration notes, and bootstrap report.

## 9. New provisional rules

- [NEW_PROVISIONAL_RULE] Information density: avoid oversized whitespace before users have seen enough concrete value.
- [NEW_PROVISIONAL_RULE] Landing page clarity: explain concrete value, show context/proof, and then ask for action.
- [NEW_PROVISIONAL_RULE] Brand fit: avoid generic SaaS-looking sections when the project has a specific industry identity.
- New guardrail: interaction continuity for local UI interactions.

## 10. Self-corrections

- [SELF_CORRECTION] none

## 11. Memory updates

- feedback log: added cross-project seed entries for information density, interaction continuity, landing page clarity, and brand fit.
- self corrections: template created; no correction entry added.
- lesson candidates: template created; no candidate added.
- global lessons: template created; no finalized lesson added.

## 12. Adapter consistency

- workspace AGENTS.md: thin adapter to `_AI_WORKFLOW/core/AGENTS.md`.
- wrapper AGENTS.md / CLAUDE.md: none.
- project AGENTS.md: thin adapter to workspace core and project rules.
- project CLAUDE.md: thin adapter via `@AGENTS.md`.
- Cursor rule: thin always-apply rule with required frontmatter.
- shared project source: `docs/AI_AGENT_PROJECT_RULES.md`.
- known drift remaining: none from existing adapters; active project inference and hot file list need review.

## 13. Migration notes

- workspace migration notes: `_AI_WORKFLOW/MIGRATION_NOTES.md`
- project migration notes: `docs/AI_WORKFLOW_MIGRATION_NOTES.md`

## 14. Risks / needs review

- Active project was inferred from multiple candidates.
- Direct-main deploy policy is unknown; conservative no-direct-main default is active.
- Hot file list is inferred and should be reviewed.
- Production persistence mode is unknown; project docs mention both JSON fallback and Supabase Postgres.

## 15. Verification

- business code modified: no
- secrets exposed: no
- sibling projects modified: no
- existing project-specific rules deleted: no
- random migration notes created: no

## 16. Post-bootstrap hardening addendum

### Active project detection policy updated

- current working directory / current Cursor workspace is preferred: yes; `_AI_WORKFLOW/core/AGENTS.md` and `_AI_WORKFLOW/SOP/NEW_PROJECT_BOOTSTRAP.md` now prefer the current workspace/directory when it has project markers.
- UI/UX seed text is not allowed to select a sibling project: yes.
- multiple sibling projects behavior: if no clear active project exists, only workspace `_AI_WORKFLOW/` should be created/updated and the report should say `No active project selected; run "接入 AI 工作流" from the target project workspace.`

### Default automation clarified

- ordinary development tasks use AI Workflow automatically: yes.
- user does not need to say "AI Workflow": yes.
- UI/UX routing is automatic: yes.
- testing routing is automatic: yes; project rules keep infra-vs-regression classification and self-correction routing.
- post-task lightweight lesson routing is automatic: yes.
- heavy workflow retrospective is explicit or threshold-triggered: yes; `复盘 AI 工作流` remains the heavier review mode.

### Needs-review resolution

- active project: resolved for this hardening pass because this project already has `docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md`; original bootstrap target selection still remains reviewable because the first run started from a workspace root with multiple sibling project candidates.
- direct-main deploy: still open; existing docs mention GitHub-to-Railway deployment but do not prove a branch policy or intentional direct-main deploy.
- inferred hot files: partially resolved; `docs/AI_AGENT_PROJECT_RULES.md` and `docs/ARCHITECTURE.md` now split evidence-backed hot/core files from broader inferred admin/ownership boundaries that still need review.
- persistence mode: partially resolved; docs now distinguish current documented options, local/default JSON fallback, temporary Railway Volume fallback, Supabase Postgres production target, and unresolved live deployment mode.

### Source attribution check

- FEEDBACK_LOG seed source: verified as `source_project: cross-project seed from user prompt`.
- UI_UX_SCALE seed source: verified as cross-project seed from user prompt; no prompt-seeded rule was attributed to Jose Expressline Consulting.

### Files updated in hardening pass

- `_AI_WORKFLOW/core/AGENTS.md`
- `_AI_WORKFLOW/SOP/NEW_PROJECT_BOOTSTRAP.md`
- `_AI_WORKFLOW/SOP/LESSON_ROUTING.md`
- `AGENTS.md`
- `CLAUDE.md`
- `.cursor/rules/project-context.mdc`
- `docs/AI_AGENT_PROJECT_RULES.md`
- `docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md`
- `docs/AI_WORKFLOW_MIGRATION_NOTES.md`
- `docs/ARCHITECTURE.md`
- `docs/DATABASE_SCHEMA.md`

### Verification

- business code modified: no
- sibling projects modified: no
- git config/remotes modified: no
- existing project-specific rules deleted: no

## 17. Final root adapter cleanup

- workspace root AGENTS.md checked: yes
- workspace root CLAUDE.md checked: yes
- stale sibling selection wording removed: yes; removed the old instruction to choose the most likely active project from multiple candidates
- workspace root now defers active project detection to current workspace / cwd: yes
- UI/UX seed text cannot select a sibling project: yes
- recent modification time cannot select a sibling project: yes
- business code modified: no
- sibling projects modified: no
- git config/remotes modified: no
