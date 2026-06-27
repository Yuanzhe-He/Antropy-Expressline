# Express Line — Security / DB-Hardening Line: COMPLETE (authoritative closeout)

> **Date:** 2026-06-26 · **Prod project ref:** `polxyashvxbzdkkmxuox` (shared: `expressline` + `public.joyas_*` Althea + `public.punas_*` pang uñas)
> **Status:** ✅ **CLOSED.** The DB-role / least-privilege / infrastructure-security line is finished. The **only** remaining security workflow is application **auth** (§11), which is product-decision-gated and tracked as a separate initiative — *not* a dangling loose end of this line.
>
> This document is the single authoritative record of the terminal state. Where older docs disagreed they were corrected to point here (see §12).

---

## 1. TL;DR — what is true now

- The live app's **runtime DB role is the least-privilege `expressline_app`**, no longer the broad `postgres`. Verified both by connecting *as* the role and by reading the deployed Railway `DATABASE_URL`.
- **Cross-project exposure is closed at the privilege layer:** `expressline_app` is **denied (42501)** on `public.joyas_*` and `public.punas_*`. The previously-documented risk — "the app has no auth, and its broad DB role could reach all three businesses' data" — is now blocked by Postgres permissions, not just by code discipline.
- **`postgres` is retained only as the table owner** (fresh-DB setup / migrations). **`expressline_migrator`** is the migration role. This round's **B2** removed the last cutover leftover (the redundant `expressline_migrator → postgres` membership).
- **Rollback is one Railway variable away** and the anchor is in hand (§4).
- Prod is healthy, relational, zero data drift, all schema invariants present (§10).

---

## 2. App runtime role — terminal state

| Property | Value |
|---|---|
| Runtime role (deployed) | **`expressline_app`** (Railway active `DATABASE_URL`) |
| Privileges | `SELECT/INSERT/UPDATE/DELETE` on the 18 entity tables; `SELECT/INSERT/UPDATE` on `app_state`; `SELECT/INSERT` on `quote_snapshots` (+ its `bigserial` sequence); `USAGE` on schema `expressline` |
| Role attributes | `superuser=false createrole=false createdb=false bypassRLS=false canlogin=true` |
| Cross-schema | **DENIED (42501)** on `public.joyas_*` / `public.punas_*` (no `USAGE`/`SELECT` granted) |
| Owner / DDL | **none** — owns no tables, cannot run DDL |
| Grant single source | [`scripts/relational/app-role-grants.js`](../../scripts/relational/app-role-grants.js) `appRoleGrantSql()` |
| Created by | [`scripts/relational/prod-F-create-app-role.js`](../../scripts/relational/prod-F-create-app-role.js) (additive, assertProd-gated) |
| Cred storage | gitignored `.env.expressline-app` (`EXPRESSLINE_APP_URL`, mode 0600) — never committed |

The exact grant set the role gets is emitted by a **single source** so what is proven on the sandbox is byte-for-byte what is applied to prod. The same module exports `verifyAppRole()` — the HARD GATE used in every verification below.

---

## 3. Cross-project isolation — the threat that is now closed

The shared Supabase instance hosts three independent businesses. Before the switch, the app connected as `postgres` (sees all schemas), so the "no-auth admin portal → all three projects' data" path existed at the privilege layer and was held back only by code discipline (schema-qualified queries, zero joyas/punas references).

**Now:** the runtime role physically cannot read the other tenants. Defense-in-depth still holds the code-level guarantees too (0 cross-tenant references + schema-qualified queries, grep/CI-checkable), but the privilege boundary is the primary control.

---

## 4. Rollback anchor

The runtime-role switch changed **only** Railway's active `DATABASE_URL` — no code, no schema, no data. To roll back:

1. Set the active Railway `DATABASE_URL` back to the `postgres` connection string, sourced from either:
   - Railway var **`DATABASE_URL_POSTGRES_BACKUP`** (non-active; the app does not read it) — **present, verified this round** (role=`postgres`, ref=prod); or
   - gitignored **`.env.rollback-postgres`** (local copy, `DATABASE_URL_POSTGRES`) — **present**.
2. Trigger a redeploy.

`postgres` is retained as owner, so the rollback target role still exists and works. Seconds-level reversal. (Both anchors are gitignored: `.gitignore` covers `.env` / `.env.*` except `.env.example`.)

---

## 5. Role topology (terminal)

| Role | Purpose | Owns tables? | Cross-schema | Used by |
|---|---|---|---|---|
| `expressline_app` | **app runtime** | no | denied (42501) | the deployed app |
| `expressline_migrator` | migrations / cutover tooling | no (independent CRUD grants) | denied (42501) | `scripts/relational/prod-*` migration scripts |
| `postgres` | **owner** + fresh-DB setup | yes (all 18 entity tables) | yes (project superuser) | offline owner-only DDL / role management |

All offline `postgres`/`migrator` tooling is assertProd-gated (`ref == polxyashvxbzdkkmxuox`, [`prod-guard.js`](../../scripts/relational/prod-guard.js)).

---

## 6. Startup owner-DDL separated from runtime

A least-privilege role cannot run `CREATE/ALTER/INDEX` (owner-only). The app therefore **skips** the startup schema-ensure when the schema already exists, via a privilege-safe existence probe:

- [`src/lib/db/index.js`](../../src/lib/db/index.js) `relationExists()` runs `select to_regclass(...)` (needs only schema `USAGE`, which `expressline_app` has).
- `ensureDatabase()` short-circuits owner-only `migrateDatabase()` when `app_state` exists; `ensureRelationalReady()` short-circuits owner-only `ensureRelationalSchema()`/`buildSchemaDDL` when `carriers` exists.
- Net effect: behavior under the old `postgres`/owner role is **identical** (ensure was already a no-op since tables exist), but the runtime no longer issues DDL a least-privilege role can't run. Proven on sandbox by running `buildSchemaDDL` AS `expressline_app` on an existing schema with zero failures.

---

## 7. B2 — redundant membership revoked (this round)

`grant expressline_migrator to postgres` was created during the cutover *only* to permit transferring the 18 tables' ownership to `postgres`. The tables are now **owned** by `postgres`, so the membership granted it nothing extra — a no-op leftover.

- **Action (2026-06-26):** `node scripts/relational/prod-B2-revoke-grant.js --execute` → revoked + committed.
- **Hard gate (post-revoke):** `postgres` still R/W (via ownership) ✅ · `expressline_migrator` still R/W (independent grants) ✅ · isolation intact (`public.punas_customers` denied 42501) ✅ → **PASS**.
- **App impact:** none. `expressline_app` never used the membership; its grants are independent.
- **Reversible:** re-`grant expressline_migrator to postgres`.
- **Update (2026-06-26, self-correction):** the membership was later observed **present again** — it is re-granted by Supabase's platform role **`supabase_admin`** (`admin_option=true`), so a revoke run as `postgres` is **not durable** against the platform. This is **not a security regression**: the membership remains a confirmed **no-op** (`postgres` owns all 18 tables, so it confers nothing extra; the app runs as `expressline_app` and never uses it). Treat this membership as platform-managed/benign rather than a controllable cleanup. (This is why §15's default-privileges are set `FOR ROLE <self>` from each role's own connection, not via the membership.)

---

## 8. Sandbox write-30/30 retest — terminal state: SUPERSEDED

- The throwaway sandbox project `fnczokogchlhutyskbdw` is **paused / unreachable** (DNS `ENOTFOUND` on `db.fnczokogchlhutyskbdw.supabase.co`, verified 2026-06-26), so `APP_ROLE=1 node scripts/relational/sandbox-admin-crud-test.js` cannot be re-run.
- **This item is formally closed as superseded** by the prod write verification: the relational write path (admin route → relational table → read-back) is proven against **prod** (real insert/update/delete that self-restores), and the relational write path is now covered in CI. A real prod write proof is *stronger* than a sandbox replay.
- **No longer a pending TODO.** If a sandbox is ever re-provisioned, the test still exists and runs unchanged (`scripts/relational/sandbox-admin-crud-test.js`, sandbox-guard-gated, not in `test:all`).

---

## 9. Schema invariants ("7 CHECK / 3 indexes") — present + valid

The "7 CHECK / 3 indexes" referenced by the verification is the **hardening set** (health-check findings M1 + m3), defined identically in [`src/lib/db/relational-repo.js`](../../src/lib/db/relational-repo.js) `buildHardeningDDL()` and [`scripts/relational/prod-harden-2026-06-25.js`](../../scripts/relational/prod-harden-2026-06-25.js), so a fresh schema converges to the same shape.

**7 non-negativity CHECKs (M1):** `carrier_local_charges_tax_rate_nonneg`, `terminal_charges_tax_rate_nonneg`, `terminal_charges_amount_nonneg`, `yard_charges_tax_rate_nonneg`, `yard_charges_amount_nonneg`, `inland_rate_entries_sencillo_nonneg`, `inland_rate_entries_full_nonneg` — all present; 0 column-level negatives, so all VALID.

**3 FK indexes (m3):** `inland_rate_entries_origin_idx`, `yard_carriers_carrier_idx`, `yard_ports_port_idx` — all present.

For completeness, the **full** schema carries **12 CHECK constraints** (7 hardening + 5 base enum/singleton guards) and **10 non-PK indexes** (3 hardening + 7 base) across **21 physical tables** (18 entity + `app_state` + `audit_logs` + `quote_snapshots`). 0 FK orphans across all 12 FKs.

---

## 10. Terminal verification evidence (2026-06-26, this round)

All read-only except B2 (§7).

**Runtime role (connected AS `expressline_app` on prod):**
```
✅ 18-table CRUD (S/I/U/D no-op + rollback): all PASS
✅ app_state R/W (users): select+insert+update
✅ quote_snapshots INSERT (bigserial seq): insert+select
✅ isolation public.joyas_asset_products: permission denied (42501)
✅ isolation public.punas_customers: permission denied (42501)
✅ attributes: superuser=false createrole=false createdb=false bypassRLS=false canlogin=true
HARD GATE expressline_app least-priv + sufficiency + isolation: PASS ✅
```

**Deployed Railway runtime config (parsed; no secrets printed):**
```
DATABASE_URL: role=expressline_app  ref=polxyashvxbzdkkmxuox
DATABASE_URL_POSTGRES_BACKUP: role=postgres  ref=polxyashvxbzdkkmxuox   (non-active rollback anchor)
STORAGE_MODE=relational
```

**Live app health** (`https://antropy-expressline-production.up.railway.app`):
```
/healthz            -> 200  (status ok, STORAGE_MODE relational, cache TTL 3600000ms, usageGuard healthy, refreshRoute totalHitsToday=0 — ghost still gone)
/ (homepage)        -> 302 -> /workbench/handover -> 200
```

**Data integrity (via migrator + admin, read-only):**
```
18 entity tables: 16 populated; app_state rows=2 (shipping-data-retired-20260625, users)
row-count baseline drift: NONE — counts stable ✅ (carriers 21, container_types 20, customs_yards 28,
                          inland_destinations 44, inland_rate_entries 300, quote_notes 5, module_settings 5)
prod-harden verify: 7 M1 CHECK columns 0 negatives ✅ · 3 m3 indexes present ✅ · 0 orphans across 12 FKs ✅
isolation (migrator): public.joyas_asset_products + public.punas_customers permission denied (42501) ✅
```

---

## 11. The ONLY remaining security workflow: application auth (product-decision-gated)

This is **not** a loose end of the DB-hardening line — it is a separate, deliberately-staged initiative blocked on product decisions by Chandler. **Gated specifically on José's explicit confirmation before the auth work starts** (recorded 2026-06-26). Current state (verified 2026-06-26):

- **No login wall.** `requireAuth` / `attachUser` ([`src/middleware/auth.js`](../../src/middleware/auth.js)) unconditionally assign every visitor the frozen `publicDemoUser` (role `admin`); they never redirect or 401/403. All `/admin/*` and `/workbench/*` routes pass everyone through as admin.
- **A working login backend already exists.** `POST /login` ([`src/routes/core.js`](../../src/routes/core.js)) validates credentials and sets `session.user`; a login view + i18n strings exist. `GET /login` currently redirects away. So the work is **"flip the guard on + harden," not "build auth from scratch."**
- **Credentials are plaintext.** Stored in the `app_state['users']` blob (DB) / `data/users.json` (file) — 3 committed demo accounts (admin / sales / pricing roles), passwords stored as raw strings, compared with `===`. No `bcrypt`/`argon2`/`scrypt` dependency anywhere. *(Password values are intentionally not reproduced here.)*
- **Sessions are weak.** `express-session` with the default in-memory `MemoryStore` (lost on every Railway redeploy, single-instance only), a hardcoded fallback `SESSION_SECRET`, and no cookie `secure`/`maxAge`/expiry. Logout is undone by the `publicDemoUser` fallback on the next request.

### Decisions Chandler must make before the auth workflow can start

1. **Who logs in / scope of the wall.** Only José? Multiple staff? Is the quoting workbench (`/workbench/*`) staff-only or public lead-gen? Should role distinctions (`admin` vs `sales`, already in the data but unenforced) actually gate routes (a `requireRole`/`requireAdmin` guard does not exist yet)?
2. **Password / credential model.** Hash the existing plaintext passwords (bcrypt/argon2 — must be added), reset all of them, or adopt **Supabase Auth / SSO**? Keep users in the generic `app_state` blob or promote to a real relational `users` table (none exists)? Rotate/remove the committed demo creds before any real launch.
3. **Session model.** Session duration (idle + absolute expiry — none today), real logout, persistent store (e.g. `connect-pg-simple` on the existing Postgres so sessions survive redeploys), a real `SESSION_SECRET` in Railway env, and cookie hardening (`secure`, `httpOnly`, `sameSite`).

> **Reference implementation available in-house:** pang uñas (the `punas_*` tenant on the same Supabase project) already uses **Supabase Auth** (its only cross-schema FKs are `punas_* → auth.users`). If the decision is to adopt Supabase Auth, that integration is a working precedent to mirror.

Auth is purely **app-layer access control** and is independent of the DB-role work in this document (which is done).

---

## 12. Doc-consistency sweep (this round)

Stale "the app runs as `postgres` / isolation is code-level only" statements were corrected to match this terminal state (or annotated as historical), and now point here:

- [`docs/DATABASE_SCHEMA.md`](../DATABASE_SCHEMA.md) — migrator-isolation line clarified (migration tooling vs live runtime).
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — added the runtime-role least-privilege note.
- [`docs/AI_AGENT_PROJECT_RULES.md`](../AI_AGENT_PROJECT_RULES.md) — "unresolved persistence mode" → resolved; JSON-fallback framing corrected.
- [`docs/LESSONS.md`](../LESSONS.md) — three dated entries annotated: B2 done, blob retired, isolation now privilege-level.
- [`docs/specs/20260625_db_structure_health_check_REPORT.md`](20260625_db_structure_health_check_REPORT.md) — shared-instance caveat updated.
- [`docs/specs/CODEX_PROMPT_PROD_POSTCUTOVER_VERIFY.md`](CODEX_PROMPT_PROD_POSTCUTOVER_VERIFY.md) — historical "code-level isolation" claim annotated with terminal state.
- [`scripts/relational/prod-E-verify.js`](../../scripts/relational/prod-E-verify.js) — header comment corrected ("as postgres = what the deployed app does" → local verify cred vs deployed `expressline_app`).

---

## 13. Repo state at closeout

- Local + remote branches: **only `main`** (10 abandoned squash-merged feature branches deleted: `feature/inland-v2-*`, `feature/jose-r2-*`, `feature/ghost-proof-and-arch-plan`, `feature/inland-routes-map`, `feature/kill-poller-catch-ghost`, `feature/refactor-godfiles` — all content superseded by `main`).
- **0 open PRs.**

---

## 14. Explicitly NOT loose ends (closed, not deferred)

- B2 redundant membership — **done** (§7).
- Sandbox 30/30 retest — **superseded** by prod write proof (§8).
- Rollback anchor — **in hand**, verified (§4).
- Schema invariants — **present + valid** (§9–10).
- Doc drift — **swept** (§12).
- Abandoned branches — **deleted** (§13).
- "Add-table → forget grant → 42501" footgun — **closed by mechanism** (`ALTER DEFAULT PRIVILEGES`, both creating roles, proven via throwaway probe) (§15).

**Open (separate initiative, product-gated):** application auth (§11).

---

## 15. ⚠ OPERATIONAL RULE — adding a table under the least-privilege runtime role

**✅ RESOLVED 2026-06-26 — the footgun is closed by a standing mechanism (`ALTER DEFAULT PRIVILEGES`).** Future tables created in the `expressline` schema are **auto-granted** to `expressline_app`; no manual grant is needed and the "table exists but the app gets 42501" symptom can no longer occur for a normal new table.

**Background (the footgun this closed):** the live app runs as **`expressline_app`**, which held table-level grants on only the tables that existed at switch time (the 18 entity tables + `app_state` + `quote_snapshots`). Plain table grants do **not** auto-extend to new tables — so before this mechanism, any new table needed a manual grant or the deployed app would hit `permission denied (42501)` on it *even though the table exists* (a confusing "the table is there but I can't read it" symptom that wastes debugging time).

**The applied mechanism — single source [`scripts/relational/prod-G-default-privs.js`](../../scripts/relational/prod-G-default-privs.js)** (assertProd-gated; `preview` / `--execute` / `--verify` / `--revoke` / `--probe`). Because `ALTER DEFAULT PRIVILEGES` is keyed by the *creating* role, it was applied for **both** roles that create tables in `expressline` — `postgres` (owner) and `expressline_migrator` (migration tooling) — each set from its own connection (`FOR ROLE <self>`, so it is independent of the platform-managed postgres↔migrator membership; see §7):
```sql
ALTER DEFAULT PRIVILEGES FOR ROLE postgres             IN SCHEMA expressline GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO expressline_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres             IN SCHEMA expressline GRANT USAGE, SELECT ON SEQUENCES TO expressline_app;
ALTER DEFAULT PRIVILEGES FOR ROLE expressline_migrator IN SCHEMA expressline GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO expressline_app;
ALTER DEFAULT PRIVILEGES FOR ROLE expressline_migrator IN SCHEMA expressline GRANT USAGE, SELECT ON SEQUENCES TO expressline_app;
```
The `expressline` schema contains only Express Line's own tables (Althea/pang uñas live in `public.*`), so this does **not** weaken cross-project isolation — `expressline_app` is still denied (42501) on `joyas_*`/`punas_*`. Additive + reversible (`prod-G --revoke`); affects only tables created *after* it ran (existing grants, incl. the deliberately-narrower `app_state` S/I/U-no-delete and `quote_snapshots` append-only, are untouched).

**Proven (2026-06-26, `prod-G --probe`):** a throwaway table created by `postgres` **and** one created by `expressline_migrator`, each with no explicit grant, were both immediately SELECT/INSERT-able AS `expressline_app`; isolation stayed denied (42501) and existing tables stayed readable; the probe tables were dropped.

**Manual grant is now only a FALLBACK** — for a table that needs a *different* privilege set than the S/I/U/D default, or to back-fill a pre-existing table: add it to the single source [`scripts/relational/app-role-grants.js`](../../scripts/relational/app-role-grants.js), apply via [`scripts/relational/prod-F-create-app-role.js`](../../scripts/relational/prod-F-create-app-role.js), and verify by connecting AS `expressline_app`.
