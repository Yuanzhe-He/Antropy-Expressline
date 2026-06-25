# Project Claude Adapter

@AGENTS.md

Also use:

- `../_AI_WORKFLOW/core/AGENTS.md`
- `docs/AI_AGENT_PROJECT_RULES.md`
- `.ai/PROJECT_SCALE_OVERRIDES.md`

Keep this file thin. Project facts and project-specific hard rules belong in `docs/AI_AGENT_PROJECT_RULES.md` and related project docs.

Ordinary development tasks use AI Workflow automatically after connection; explicit workflow commands are mode shortcuts.

Every task must end with the exact `Post-task routing` block defined in `docs/AI_AGENT_PROJECT_RULES.md`. Do not replace it with only `Durable lesson captured: none`.
