# Project Agent Adapter

Active project: `Jose Expressline Consulting`

Read before project work:

- `../_AI_WORKFLOW/core/AGENTS.md`
- `docs/AI_AGENT_PROJECT_RULES.md`
- `.ai/PROJECT_SCALE_OVERRIDES.md`

Read task-relevant project docs only:

- `docs/ARCHITECTURE.md`
- `docs/DATABASE_SCHEMA.md`
- `docs/business-process.md`
- `docs/product-uiux-audit.md`
- `docs/UX_REVIEW_NOTES.md`
- `docs/BRAND_NOTES.md`
- `docs/LESSONS.md`

Use repo-local docs for project facts and project-specific contracts. Use the workspace `_AI_WORKFLOW` layer for reusable workflow, scales, memory, and playbooks.

After this project is connected, ordinary development tasks use AI Workflow automatically. Explicit workflow commands are mode shortcuts, not prerequisites.

Every task must end with the exact `Post-task routing` block defined in `docs/AI_AGENT_PROJECT_RULES.md`. Do not replace it with only `Durable lesson captured: none`.

For `只做 UI/UX 评审`, review only and do not modify code.

Do not expose secrets or raw credentials. Treat real database URLs, API keys, session secrets, cookies, and passwords as sensitive.

During AI workflow bootstrap tasks, do not modify business code.
