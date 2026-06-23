# Production cutover runbook — `app_state` blob → relational (UNEXECUTED)

> Status: **PLAN ONLY — nothing here has run against production.** Every step is a
> HARD STOP: do it, report with verification output, then wait for Chandler's
> explicit "go" on the next step. Source: `docs/specs/CODEX_PROMPT_blob_to_relational_FULL.md`
> §5 + the prod-cutover prompt. Local 2a→2b is verified on sandbox
> `fnczokogchlhutyskbdw` (parity=0, integration 7/7, concurrency 5/5, test:all 14/14).

## ⚠ The target is a SHARED production project — three live businesses
`polxyashvxbzdkkmxuox` ("Other Projects" / "Free Org") hosts, in ONE Supabase project:
- **`expressline`** schema (ours: `app_state`, `audit_logs`, `quote_snapshots`)
- **`public.joyas_*`** (18 tables — Althea jewelry)
- **`public.punas_*`** (12 tables — pang uñas nails)

So "touch prod" = touch a project holding three businesses. **Only the `expressline`
schema may be touched; `joyas_*` / `punas_*` must have ZERO contact.**

## 0. Three iron rules
1. Only `expressline` schema. Never `public.joyas_*` / `public.punas_*` / other schemas.
2. One step at a time — stop after each, report verification, wait for explicit go.
3. Every step reversible — the blob stays source of truth until relational is proven.

## Prerequisites NOT yet met (must clear before Step 1)
- [ ] **2b route integration** — swap the ~60 admin write routes from
      `saveShippingData(whole)` to the per-entity facade methods
      (`saveCarrier`/`saveCustomsYard`/`saveInlandRateEntry`/…). The methods + proof
      exist (commit `f21835e`); the wrappers fall back to whole-save in blob/json, so
      adoption is safe and can be incremental (one admin module per commit, each
      `test:all`-green). Until done, relational mode persists per-entity but routes
      still send whole documents (the per-entity *write granularity* benefit needs the
      route swap; the per-entity *read/representation* benefit is already in 2a).
- [ ] **PR reviewed + merged** to the deploy branch (Railway tracks `main`).
- [ ] **Restricted prod DB role** (see §2) — created and isolation-proven.

## 2. Production cutover guard (write + prove BEFORE any DDL) — stricter than sandbox
The sandbox guard says "only sandbox, never prod". Cutover needs the inverse, at TWO layers:
- **(a) ref assertion** — `DATABASE_URL` project ref MUST == `polxyashvxbzdkkmxuox`
  (the only scenario that legitimately targets prod). Reuse `scripts/sandbox-guard.js`
  `extractProjectRef`, but assert `== prod` here.
- **(b) schema-restricted ROLE (more important than the ref)** — connect with a DB role
  that has privileges on `expressline` ONLY and NONE on `public`/`joyas_*`/`punas_*`.
  Lock `search_path` to `expressline`. All cutover SQL stays explicitly `expressline.`-qualified.
  Suggested (run by Chandler / a superuser, once):
  ```sql
  create role expressline_migrator login password '<set>';
  revoke all on schema public from expressline_migrator;
  grant usage, create on schema expressline to expressline_migrator;
  grant all on all tables in schema expressline to expressline_migrator;
  alter role expressline_migrator set search_path = expressline;
  ```
- **(c) PROVE isolation first** — with that role, run and PASTE the output of:
  ```sql
  select 1 from public.punas_customers limit 1;   -- MUST be: permission denied
  select 1 from public.joyas_products  limit 1;   -- MUST be: permission denied
  ```
  If either returns a row (not permission denied), **STOP** — the role is not isolated;
  do not proceed. No superuser bare-run against prod.

The cutover reuses the SAME verified code as the sandbox: `src/lib/store/relational-repo.js`
(DDL + I/O), `src/lib/store/relational-map.js` (decompose/assemble), `scripts/relational/gates.js`
(Q4/Q5). Only the connection target + guard differ. A prod wrapper of the sandbox scripts
(swap `connectSandbox` for a prod-guarded pool) is the one piece to write at cutover time.

## 3. Cutover steps — each a HARD STOP

**Step 1 — Backup (expressline only).** Export prod `expressline.app_state` (+ `audit_logs`,
`quote_snapshots`) to a verifiable file with row counts + sha256. Do NOT export joyas/punas.
→ report file path + checksums. **[STOP — Chandler confirms backup exists & is restorable]**

**Step 2 — Create tables (expressline only).** Run the sandbox-verified `buildSchemaDDL`
(18 tables) in prod `expressline` via the restricted role. Does NOT touch `app_state`.
→ report tables created + `app_state` untouched. **[STOP]**

**Step 3 — Forward migrate + prod-data gates.** `expressline.app_state` blob → entity tables.
Run, on the REAL prod blob (where José's method-B yard↔line mappings actually exist):
- **Q4 orphan gate** (`scripts/relational/gates.js` `orphanGate`) — every `yard.shippingLineIds`
  ∈ carriers, every customs line id ∈ handover, every line.yardIds ∈ yards.
- **Q5 currency gate** (`currencyGate`) — every currency ∈ {MXN,USD}; the `check` constraint
  also rejects fail-loud (no silent coerce).
Any gate hit → **STOP, report, wait for Chandler's reconcile decision** (do not bypass).
→ report migrated row counts + both gate results. **[STOP]**

**Step 4 — Parity gate (prod).** Canonical data diff (`scripts/relational/parity.js` logic):
blob projection vs table projection = **0**, plus José hand-edit spot-checks
(CMA doc fee 50 / KMTC ISD 15 / ZIM rename / COSCO reprice / 2 self-built yards / 7 empty-shell
carriers). → paste parity report (must be diff=0). **[STOP — Chandler confirms diff=0]**

**Step 5 — Deploy STORAGE_MODE=dual.** Writes blob+tables, reads blob, shadow-reads tables and
diffs. Observation window: José edits → dual-write; shadow diff monitored. Re-run parity before
the next switch (captures any in-flight José edits). → report observation-window diff. **[STOP]**

**Step 6 — Deploy STORAGE_MODE=relational.** Reads/writes tables; blob kept as fallback one window.
→ report app health + key paths (quote gen, an admin write) exercised live. **[STOP]**

**Step 7 — Per-entity writes (2b) effective.** With the route call-sites swapped, admin writes are
targeted. → report a concurrent two-entity edit doesn't clobber (the prod analog of the 5/5 proof). **[STOP]**

**Step 8 — Retire blob fallback (after a safe window).** Stop writing the blob → eventually drop the
`app_state` blob row/column (expressline only). **[STOP — final confirm]**

## 4. José edit window
Backup→migrate→switch may overlap José editing prod. Step 5's dual window captures his edits
(dual-write); re-run parity immediately before each switch to confirm none were lost. Prefer
running Steps 1–4 in a low-activity window.

## 5. Rollback (any step)
`STORAGE_MODE=blob` (instant revert to the blob path) + the reverse migration
(`scripts/relational/migrate-reverse.js` logic, table→blob, verified `reverse==normalize`) +
the Step-1 backup. The blob remains source of truth until Step 8. New tables can be `drop`ped
(data still in the blob) — expressline only.

## 6. Deploy ordering (Railway tracks main; no auto-migrate)
Schema + data migration (Steps 2–3) must complete in prod `expressline` BEFORE the relational
deploy (Step 6). Express Line does not auto-migrate on deploy.

---
*Generated 2026-06-22 alongside the local 2a→2b work. Nothing here executed. Advance only on
Chandler's explicit per-step "go".*
