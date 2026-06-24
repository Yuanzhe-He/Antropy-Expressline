# Production cutover runbook — `app_state` blob → relational (STEPS 1–6 EXECUTED; 7–8 PENDING)

> Status: **LIVE IN RELATIONAL. Steps 1–6 EXECUTED against prod on 2026-06-24.** The app
> (Antropy-Expressline, Railway project `courteous-courage`) now reads+writes the entity
> tables (`STORAGE_MODE=relational`); the `app_state` blob is **frozen** as the rollback
> anchor (NOT retired — Step 8 pending). Step 7 (per-entity targeted writes) is implicitly
> active in relational mode. Source: `docs/specs/CODEX_PROMPT_blob_to_relational_FULL.md` §5
> + the prod-cutover prompts. Local 2a→2b verified on sandbox `fnczokogchlhutyskbdw`
> (parity=0, integration 9/9, concurrency 5/5, test:all 14/14).
>
> **EXECUTION RECORD — Steps 5–6 (app deploy → dual → relational) on 2026-06-24:**
> Harness `scripts/relational/prod-{A-grant-app-role,fix-ownership,D-shadow,E-verify}.js`.
> - **Railway auth** (Phase 0): linked service Antropy-Expressline, prod ref polxyashvxbzdkkmxuox, role postgres; STORAGE_MODE was unset/blob.
> - **App-role grants** (Phase 1): granted postgres SELECT/INSERT/UPDATE/DELETE on the 18 tables (by owner migrator); proved per-table S+I+U+D+rollback.
> - **Push + merge** (Phases 2-3): pushed the 25 relational commits → PR #22 (43 commits) → merged (merge commit `bb4930a8`); Railway deployed `08546f87`. Smoke green, STORAGE_MODE still blob, behavior unchanged.
> - **Ownership fix** (pre-Phase 4): the app-as-postgres could not run `ensureRelationalSchema` (ALTER/CREATE INDEX are owner-only → "must be owner of table carriers"). Transferred all 18 tables' ownership migrator→postgres (re-granted migrator CRUD). REQUIRED before dual.
> - **Dual + shadow** (Phase 4): `STORAGE_MODE=dual` (deploy `6b8d0381`); re-aligned (re-pin live blob + re-migrate); shadow via the store facade `blob(post-drop) == relational` = the 8 known drops, nothing else. NB: the static pin-vs-tables parity is unsuitable under live FX writes (it reverts the tables' FX to the pin); the **facade shadow** is the correct gate.
> - **Relational** (Phase 5): `STORAGE_MODE=relational` (deploy `2d624a6e`, ● Online). Live read smoke from TABLES (carriers render), relational-facade José spot-checks all correct (cmaDocFee=50/kmtcIsd=15/ZIM/COSCO/2 self-built yards/7 shells). joyas/punas still isolated.
>
> **ROLLBACK (relational → blob, lossless) — EXACT COMMANDS (verified scratch-key 2026-06-24):**
> The blob is frozen, so do NOT just set `STORAGE_MODE=blob` (loses relational-era edits).
> The reverse WRITE path is `scripts/relational/prod-reverse-to-blob.js` (postgres/admin creds —
> the only role that can write `app_state`). Lossless round-trip (decompose(rebuilt)==tables,
> normalize(assemble(decompose(rebuilt)))==rebuilt, José spot-checks) was proven on the live
> tables writing ONLY the scratch key `shipping-data-rollback-test` (live `shipping-data` revision
> unchanged). To actually roll back:
> ```bash
> # ① write the CURRENT tables (incl. relational-era edits) back into the live shipping-data blob:
> node scripts/relational/prod-reverse-to-blob.js --apply --i-understand-this-overwrites-the-live-blob
> # ② flip the app back to the blob path:
> railway variables --set STORAGE_MODE=blob
> ```
> (Without `--apply` the script writes only the scratch key and proves the round-trip — safe to
> re-run anytime as a rollback drill.) The deeper anchor stays the Phase-0 raw backup
> `backups/prod-cutover-…/app_state.json` (pre-cutover blob, before any of this) +
> `.prod-migration-pin.json`. Anchors are gitignored and untouched.
>
> **EXECUTION RECORD — Steps 1–4 on prod `polxyashvxbzdkkmxuox` (2026-06-24, app untouched):**
> Harness `scripts/relational/prod-{guard,env,00-backup,01-role-and-isolation,02-create-tables,03-migrate-forward,04-parity-reverse,99-final-verify}.js`
> (prod wrapper of the sandbox-verified modules; only the connection target + guard differ).
> - **Backup** (Phase 0): `backups/prod-cutover-2026-06-24T03-34-46-938Z/` — app_state(2,
>   sha 10a690a2…), audit_logs(0), quote_snapshots(5, sha 1140534e…). Gitignored.
> - **Restricted role + isolation** (Phase 1): `expressline_migrator` created; SELECT-only on
>   existing app_state/audit_logs/quote_snapshots (stricter than this doc's `grant all` — the
>   role CANNOT modify app_state), USAGE+CREATE on `expressline` (owns the new 18 tables). Proof:
>   migrator SELECT on joyas_asset_{products,references,tags} + punas_{appointment_services,
>   appointments,balance_adjustments} = ALL permission-denied (42501); positive control passed.
>   Connects via the Supavisor pooler as `expressline_migrator.<ref>`. Creds in gitignored `.env.prod-migrator`.
> - **18 tables** (Phase 2): created via the migrator, all migrator-owned, app_state row count unchanged.
> - **Forward + DROP** (Phase 3): pinned the live blob (sha 0b7acb37…; carriers 21/yards 28/dests 44),
>   Q5 PASS → 8 dangling refs dropped (cma-cgm×2/maersk×3/zim×2/msc×1 → yard-mzo-norte/sur,
>   yard-lc-central) → Q4 post-drop PASS(0). Upserted; **app_state NOT written**.
> - **Parity** (Phase 4): DATA diff=0 (× post-migrate AND post-idempotent-reupsert); reverse==normalize
>   YES (verify-only, no rollback-key write); José edits intact (CMA doc 50 / KMTC ISD 15 / ZIM / COSCO /
>   2 self-built yards 新场站 4-5 / 7 empty-shell carriers). Final: joyas/punas still isolated.
>
> Note vs the live blob: `carrier_local_charges`=45 here (sandbox dry-run had 46) — the live blob is
> newer than `.prod-blob-snapshot.json`; José edited one charge since. Parity is against the pinned blob.

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

> **DRY-RUN DONE (2026-06-23) on a read-only copy of the real prod blob.** Found + resolved:
> (a) `customs_note text→jsonb` (object-notes data loss) — schema fix, committed; (b) **8 dangling
> carrier→yard refs** (cma-cgm/maersk/zim/msc → removed demo yards) — **DROP reconcile approved**:
> `migrate-forward` now Q5 → `dropDanglingRefs` (drops ONLY refs to non-existent targets = lossless,
> logs each; any OTHER orphan class still aborts Q4) → Q4 post-drop. On real data: 8 dropped, Q4 PASS,
> **parity = 0**, reverse-verified, José edits intact (CMA doc fee 50). The 4 carriers become yard-less
> but so are all 21 (método B) — not anomalous.

**Step 3 — Forward migrate + prod-data gates + DROP reconcile.** `expressline.app_state` blob → entity tables.
Run, on the REAL prod blob:
- **Q5 currency** (raw) → **`dropDanglingRefs`** (lossless drop of the 8 dead links, each logged for audit)
  → **Q4 orphan** (post-drop; ABORTS on any remaining orphan — never silently swallowed).
- the original Q4 contract — every `yard.shippingLineIds` ∈ carriers, every customs line id ∈ handover,
  every line.yardIds ∈ yards — now holds after the drop.
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
> ⚠ The working `app_state` blob retains the 8 dangling refs (rollback source), but the tables are
> cleaned by the DROP — so the dual shadow diff will show exactly those 8 known drops, NOT drift.
> Either (a) apply `dropDanglingRefs` to the blob side of the shadow compare, or (b) clean the
> working blob too (write the dropped blob to `app_state`; the Step-1 raw backup stays the rollback).
> Confirm the only shadow delta is the 8 known drops; any OTHER delta is real drift → stop.

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
