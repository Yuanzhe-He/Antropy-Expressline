# AI Workflow Repair Report

Date: 2026-05-07

Project: Jose Expressline Consulting

Canonical workflow root:
`/Users/yuanzhehe/Desktop/Cursor Project/_AI_WORKFLOW/`

## Doctor Before

Status before repair: `partially-connected / repair-needed`

Evidence:

- `AGENTS.md` existed and pointed to `../_AI_WORKFLOW/core/AGENTS.md`, `docs/AI_AGENT_PROJECT_RULES.md`, and `.ai/PROJECT_SCALE_OVERRIDES.md`.
- `CLAUDE.md` existed and delegated to `AGENTS.md`.
- `.cursor/rules/project-context.mdc` existed and pointed to project rules plus shared UI/UX scale.
- `docs/AI_AGENT_PROJECT_RULES.md` existed and included default AI Workflow automation, UI/UX routing, testing rules, hot files, lesson routing, and task summary expectations.
- `.ai/PROJECT_SCALE_OVERRIDES.md` existed as a container.
- `docs/UX_REVIEW_NOTES.md`, `docs/BRAND_NOTES.md`, and `docs/LESSONS.md` existed with recent project-specific UX, brand, and self-correction notes.
- Canonical shared workflow files were visible:
  - `_AI_WORKFLOW/core/AGENTS.md`
  - `_AI_WORKFLOW/SOP/LESSON_ROUTING.md`
  - `_AI_WORKFLOW/scales/ui-ux/UI_UX_SCALE.md`
  - `_AI_WORKFLOW/playbooks/ui-ux-review.md`
  - `_AI_WORKFLOW/memory/FEEDBACK_LOG.md`
  - `_AI_WORKFLOW/memory/SELF_CORRECTIONS.md`
  - `_AI_WORKFLOW/memory/LESSON_CANDIDATES.md`

Gap found:

- The exact required closeout block was present in canonical `_AI_WORKFLOW/SOP/LESSON_ROUTING.md`, but it was not hard-coded in Jose project-local rules/adapters.
- `docs/AI_AGENT_PROJECT_RULES.md` only required `Durable lesson captured: none` for no-lesson cases, which was weaker than the new required block.

## Connection Decision

Decision after Doctor: `partially-connected / repair-needed`

Repair scope selected:

- Rules/docs only.
- No business code.
- No backend logic.
- No data files.
- No sibling projects.
- No commit/push.
- No bootstrap rerun.

## Closeout Block Status

Before:

- Canonical shared workflow had the required block.
- Jose project-local rules did not require the exact block.

Updated:

- `docs/AI_AGENT_PROJECT_RULES.md` now requires every task to end with this exact block:

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

- `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules/project-context.mdc` now point agents to the same exact closeout block requirement.
- Agents must not replace the block with only `Durable lesson captured: none`.

After:

- `connected` for closeout enforcement at project-local rule level.
- Remaining durability risk: several rule/adapter files are currently not tracked by git.

## Recent UX Lessons Status

Checked against:

- `docs/UX_REVIEW_NOTES.md`
- `docs/BRAND_NOTES.md`
- `docs/product-uiux-audit.md`
- `docs/LESSONS.md`

Status:

- workbench mobile sidebar consumes too much first viewport: recorded in `docs/UX_REVIEW_NOTES.md` and `docs/product-uiux-audit.md`.
- `立即计算` primary action was too low: recorded in `docs/UX_REVIEW_NOTES.md` and `docs/product-uiux-audit.md`.
- tax override belongs in advanced/special-case area: recorded in `docs/product-uiux-audit.md`; reflected in `docs/UX_REVIEW_NOTES.md` as optional tax override should not block main quote action.
- DEWELL / Antropy AI / Express Line brand relationship: recorded in `docs/BRAND_NOTES.md`, `docs/UX_REVIEW_NOTES.md`, and `docs/product-uiux-audit.md`.
- admin customs long flat lists should become hierarchical/collapsible: recorded in `docs/UX_REVIEW_NOTES.md`.
- local interactions should not refresh the full page or jump back to top: recorded in `docs/UX_REVIEW_NOTES.md`, `docs/product-uiux-audit.md`, and supported by `docs/LESSONS.md` for scroll/overflow checks.

No obvious recent UX omission required a new UX or brand note in this pass.

## Workflow File Git Visibility

Commands requested:

```sh
git status --short
git ls-files AGENTS.md CLAUDE.md .cursor/rules/project-context.mdc docs/AI_AGENT_PROJECT_RULES.md docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md docs/LESSONS.md docs/UX_REVIEW_NOTES.md docs/BRAND_NOTES.md .ai/PROJECT_SCALE_OVERRIDES.md
```

Observed before repair:

```text
?? .ai/
?? .cursor/
?? AGENTS.md
?? CLAUDE.md
?? docs/AI_AGENT_PROJECT_RULES.md
?? docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md
?? docs/AI_WORKFLOW_MIGRATION_NOTES.md
?? docs/ARCHITECTURE.md
?? docs/DATABASE_SCHEMA.md
```

Tracked among requested files before repair:

```text
docs/BRAND_NOTES.md
docs/LESSONS.md
docs/UX_REVIEW_NOTES.md
```

Durability risk:

- `AGENTS.md` is not tracked.
- `CLAUDE.md` is not tracked.
- `.cursor/rules/project-context.mdc` is not tracked.
- `docs/AI_AGENT_PROJECT_RULES.md` is not tracked.
- `docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md` is not tracked.
- `.ai/PROJECT_SCALE_OVERRIDES.md` is not tracked.
- Because these are not tracked, the project may look connected locally but lose workflow enforcement in another checkout or after a clean clone.

No files were added or committed in this pass, per instruction.

## Files Updated

Rules/adapters:

- `docs/AI_AGENT_PROJECT_RULES.md`
- `AGENTS.md`
- `CLAUDE.md`
- `.cursor/rules/project-context.mdc`

Report:

- `docs/AI_WORKFLOW_REPAIR_REPORT.md`

No business code files were modified.

## Remaining Gaps

- Git durability remains unresolved until the user explicitly asks to add/commit workflow files.
- `docs/AI_WORKFLOW_BOOTSTRAP_REPORT.md` and `docs/AI_WORKFLOW_MIGRATION_NOTES.md` are visible locally but currently untracked.
- This pass did not reconcile duplicated wording across adapters beyond adding the closeout hard rule.
- This pass did not modify canonical `_AI_WORKFLOW` files because the required shared files already exist and the task scope was Jose-local repair.

## Verification

Doctor checks performed:

- Confirmed active project path: `/Users/yuanzhehe/Desktop/Cursor Project/Jose Expressline Consulting`.
- Confirmed canonical workflow root exists at `/Users/yuanzhehe/Desktop/Cursor Project/_AI_WORKFLOW/`.
- Read project adapters/rules:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `.cursor/rules/project-context.mdc`
  - `docs/AI_AGENT_PROJECT_RULES.md`
  - `.ai/PROJECT_SCALE_OVERRIDES.md`
- Checked project UX/brand/lesson docs:
  - `docs/UX_REVIEW_NOTES.md`
  - `docs/BRAND_NOTES.md`
  - `docs/product-uiux-audit.md`
  - `docs/LESSONS.md`
- Checked canonical shared workflow files:
  - `_AI_WORKFLOW/core/AGENTS.md`
  - `_AI_WORKFLOW/SOP/LESSON_ROUTING.md`
  - `_AI_WORKFLOW/scales/ui-ux/UI_UX_SCALE.md`
  - `_AI_WORKFLOW/playbooks/ui-ux-review.md`
  - `_AI_WORKFLOW/memory/FEEDBACK_LOG.md`
  - `_AI_WORKFLOW/memory/SELF_CORRECTIONS.md`
  - `_AI_WORKFLOW/memory/LESSON_CANDIDATES.md`
- Ran requested git visibility checks.
- Ran `git diff --check` after edits.
