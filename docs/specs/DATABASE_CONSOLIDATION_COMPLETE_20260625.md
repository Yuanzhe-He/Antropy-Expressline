# Database Consolidation Line — COMPLETE (CLOSED)

- Date: 2026-06-26 (work dated 2026-06-25)
- Status: **✅ CLOSED** — final end-to-end verification passed (this document is the single authoritative record).
- Scope: the whole "database" track for Express Line — blob→relational migration → structure health check → remediation → cross-project boundary annotation.
- Iron rule held throughout: prod **read-only** verification (`assertProd` ref `polxyashvxbzdkkmxuox`); **only `expressline`** touched; `joyas_*`/`punas_*` **never read (data) or modified** (census read schema + table names only); auth deliberately untouched.

---

## What was done (4 stages, one-line result each)

| Stage | Result |
|---|---|
| **1. Migration** (blob → relational) | ✅ Closed. Prod live on `STORAGE_MODE=relational` (18 entity tables); the ~1.24 MB `app_state.shipping-data` blob **retired** (frozen as rollback anchor). See [MIGRATION_COMPLETE_20260625.md](../MIGRATION_COMPLETE_20260625.md). |
| **2. Structure health check** (READ-ONLY) | ✅ Done — **no 🔴 Critical defects**. 21 tables, clean FK graph, `numeric` money, FK-isolated schema. Findings = hardening/hygiene only. See [20260625_db_structure_health_check_REPORT.md](20260625_db_structure_health_check_REPORT.md). |
| **3. Remediation** | ✅ Safe items done (M4 + M1 + FK indexes); risky/irreversible items turned into decision-ready proposals (M2/M3/audit_logs/quote_snapshots/auth). See [20260625_db_remediation_DECISIONS.md](20260625_db_remediation_DECISIONS.md). |
| **4. Cross-project annotation** (READ-ONLY) | ✅ Done — 3 businesses on one Supabase project, separation **verified clean**. See [20260625_cross_project_db_layout.md](20260625_cross_project_db_layout.md). |

---

## Final state (verified 2026-06-26)

### Code / git
- **main @ `a1eaf91`** (+ this closeout doc). The line's PRs are all merged: **#32** (M4 reverse-edge fix), **#34** (non-destructive hardening + remediation docs; superseded the auto-closed #33), **#35** (cross-project layout census). No open PRs or undeleted branches remain for this line. `npm run test:all` → **20/20**.
- Layering: `lib/db.js` → `lib/db/index.js`; `relational-map.js` + `relational-repo.js` co-located under `lib/db/`. Dependency direction `routes→lib→store→db` is clean again — no reverse imports, no cycles (M4 resolved).

### Prod schema (`expressline`, Supabase `polxyashvxbzdkkmxuox`, PG 17.6)
- **21 tables** = 18 relational entity tables + `app_state` + `quote_snapshots` + `audit_logs` (+ 2 sequences).
- **`STORAGE_MODE=relational`** (verified live). `/healthz` 200, homepage (DB-hitting) 200.
- **`app_state` = `{shipping-data-retired-20260625, users}`** only — blob retired, cutover complete.
- 18 entity tables: **zero row-count drift** vs the cutover baseline.
- **Hardening live:** 7 non-negativity `CHECK`s (`tax_rate`/`amount`/`sencillo`/`full ≥ 0`) + 3 FK indexes (`inland_rate_entries.origin_id`, `yard_carriers.carrier_id`, `yard_ports.port_id`). A negative-value insert is rejected by the CHECK (verified, rolled back). Both are also in `buildSchemaDDL` (idempotent — redeploys converge).
- **Egress root-cause still cured** (the line's origin): single read entry point is cache-guarded (~1h TTL, write-through); `/healthz` usage-guard shows single-digit reads, no alerts, no degradation — no 402/5xx.

### Cross-project layout (one Supabase project, 3 businesses)
- **51 business tables, 0 unknown, prefixes consistent, no cross-project FK** (re-verified 2026-06-26):
  - **Express Line** → `expressline` schema (21 tables) — dedicated-schema isolation.
  - **Althea** → `public.joyas_*` (18) — prefix isolation.
  - **pang uñas / nail-erp-mvp** → `public.punas_*` (12) — prefix isolation. (`punas_` **is** pang uñas.)
- `expressline` is FK-isolated; the only cross-schema FKs are `punas_*→auth.users` (Supabase Auth — pang uñas's own). Two isolation strategies coexist (dedicated schema vs `public` prefix).

---

## Rollback path (still valid)

The blob→relational cutover remains reversible (in order of preference):
1. **Rebuild the live blob from the tables, then flip the flag:** `node scripts/relational/prod-reverse-to-blob.js --apply` (rebuilds `app_state.shipping-data` from the current relational tables) → set `STORAGE_MODE=blob`. *(Do not flip `STORAGE_MODE=blob` alone — the live `shipping-data` key was retired, so bare blob mode would seed demo data; the symmetric seed guard throws to prevent that.)*
2. **Un-retire the frozen blob:** `node scripts/relational/retire-blob.js --revert` (restores `shipping-data-retired-20260625` → `shipping-data`, payload preserved).
3. **Supabase PITR** (point-in-time restore).
4. **Phase-0 backup:** `backups/prod-cutover-2026-06-24T03-34-46-938Z/app_state.json`.

The non-destructive hardening is independently revertable: `node scripts/relational/prod-harden-2026-06-25.js --revert` (drops the 7 CHECKs + 3 indexes) + git-revert the `buildSchemaDDL` hardening.

---

## Known but NOT done this line (for the future)

Deferred deliberately — analysis + recommendation in [20260625_db_remediation_DECISIONS.md](20260625_db_remediation_DECISIONS.md):

- **M2 — date columns stored as `text`** (`exchange_rates.as_of_date`/`last_checked_at`, `inland_route_cache.fetched_at`, `quote_drafts.date`/`created_at`/`updated_at`). Values are valid ISO, but **the app reads them as strings** ([src/lib/exchange-rates.js:26](../../src/lib/exchange-rates.js#L26) `lastCheckedAt.slice(0,10)`). A `timestamptz` migration needs a **code change first**; low priority.
- **M3 — `carriers.code`/`carriers.rfc`** are write-only denormalized duplicates of `notes_extra` (drop with a value backup, or wire them as authoritative — not both).
- **`audit_logs`** — dead table (created, no writer): wire a writer or drop it.
- **`quote_snapshots`** — write-only, unbounded growth: add a reader + retention policy.
- **Auth not enforced + plaintext passwords** — `publicDemoUser` admin bypass + plaintext `POST /login` against `app_state['users']`. **HIGH-risk security gap, but a separate spec-first project** (Chandler is explicitly deferring this; not part of the DB line).
- **Sandbox project `fnczokogchlhutyskbdw`** — the throwaway DEV/sandbox Supabase project used for parity/DDL validation can be deleted once no further relational migration work is expected.

---

## Conclusion

**The Express Line database consolidation line is CLOSED.** Production runs on a verified-healthy relational store, structurally audited (no Critical defects) and hardened (non-destructive); the cross-project boundaries on the shared Supabase instance are documented and verified clean; rollback remains available; and the remaining items are explicitly logged as deferred decisions for the future. No further work is required to consider this line complete.
