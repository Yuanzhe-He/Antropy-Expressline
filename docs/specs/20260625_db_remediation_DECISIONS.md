# DB Remediation — Decision-Ready Items (NOT executed)

- Date: 2026-06-25
- Source: [20260625_db_structure_health_check_REPORT.md](20260625_db_structure_health_check_REPORT.md). This doc covers the **risk/irreversible** findings that were deliberately **not executed** this round — each is analyzed (benefit / risk of not doing / reversibility) and given a recommendation for Chandler to decide.
- Already done this round (separate, safe): **M4** reverse-edge fix (code move), **M1** money/rate non-negativity CHECKs + the **3 missing FK indexes** (non-destructive, read-verified, applied to prod, revertable). See the report's remediation banner.
- Iron rule for everything below: **READ-ONLY analysis only** — no DROP, no type migration, no auth change executed here.

---

## Summary table

| Item | Type | Benefit of doing | Risk of NOT doing | Reversible? | Recommendation |
|---|---|---|---|---|---|
| D1 · M2 dates `text`→`timestamptz` | type migration (destructive-ish) | correct ordering/compare/index, tz-safe | low — values are valid ISO, app works today | Yes (ALTER back), but a **table rewrite** | **Defer** — needs a code change first (consumers read these as strings) |
| D2 · M3 drop `carriers.code`/`rfc` | DROP COLUMN (destructive) | removes write-only dup + drift risk | low — they're dead-on-read, just noise | Yes if column values backed up first | **Drop, with backup** (or keep + document) — low urgency |
| D3 · `audit_logs` dead table | wire or DROP | either a real audit trail, or less dead scaffolding | low — empty, harmless, but misleading | Wire = additive; DROP = reversible via re-create | **Wire a writer** (preferred) or DROP if audit not wanted |
| D4 · `quote_snapshots` write-only | add reader / retention | usable quote history; bounded growth | medium-low — grows unbounded, no read path | Fully reversible (additive) | **Add retention + a read surface** (keep the table) |
| D5 · enum CHECK + name UNIQUE | ADD constraint (non-destructive) | reject bad module/rate/dup-name at DB | low — app validates; 🟢 minor | Yes (DROP constraint) | **Hold** — couples DB to mutable code constants / mutable names |
| D6 · auth + plaintext passwords | **security**, spec-first | real access control + hashed secrets | **HIGH** — no auth, plaintext creds | n/a (new project) | **Separate spec-first project** (PART 4) — do not bundle here |

---

## D1 — M2: domain dates stored as `text` (→ `date`/`timestamptz`)

**Columns:** `exchange_rates.as_of_date` (date-only), `exchange_rates.last_checked_at` (ISO ts), `inland_route_cache.fetched_at` (ISO ts), `quote_drafts.date` / `created_at` / `updated_at` (ISO ts). (The entity `created_at`/`updated_at` audit columns are already `timestamptz` — not in scope.)

**Evidence gathered (read-only):**
- Data is clean/parseable: `exchange_rates` = `as_of_date='2026-06-26'`, `last_checked_at='2026-06-26T03:18:57.563Z'`; `inland_route_cache.fetched_at` = **0 of 44** non-ISO; `quote_drafts` = **0 rows** (nothing to migrate). So the data itself would convert without loss.
- **But the app reads these as strings.** [exchange-rates.js:26](../../src/lib/exchange-rates.js#L26) does `exchangeRates.lastCheckedAt.slice(0,10)` (string slice for the daily-staleness check), and the value is written as `new Date().toISOString()` ([exchange-rates.js:53](../../src/lib/exchange-rates.js#L53)). The assemble/decompose layer passes them through as text ([relational-map.js:315-316](../../src/lib/db/relational-map.js#L315), [:48-49](../../src/lib/db/relational-map.js#L48)). If the column became `timestamptz`, `pg` returns a **JS `Date`** for that column, and `.slice(0,10)` (and any other string op) **breaks**.

**Benefit:** correct chronological ordering/filtering, real index support, timezone correctness, DB-level validation (no garbage dates).

**Risk of not doing:** **Low.** Values are valid ISO and the app works today. The only real cost is that sorting/filtering by these fields is string-based (fine for ISO-8601, which sorts chronologically as text anyway) and the DB won't reject a malformed date.

**Reversibility:** `ALTER TABLE … ALTER COLUMN … TYPE timestamptz USING …` **rewrites the column** (table-rewrite + brief `ACCESS EXCLUSIVE` lock — trivial at these row counts). Reverse is another `ALTER … TYPE text` — reversible, but two heavy operations.

**Recommendation: DEFER.** Not a low-risk pure-DDL change — it requires a **coordinated code change first** (make the assemble layer emit ISO strings from `Date`, or update the string consumers like the `.slice(0,10)` staleness check). Sequence if pursued: (1) change code to tolerate `Date`/ISO from these columns, ship + verify; (2) then `ALTER TYPE` in a reviewed migration. Given the data is valid ISO-8601 (which already sorts correctly as text) and there is no current bug, the benefit is marginal — **low priority**.

---

## D2 — M3: `carriers.code` / `carriers.rfc` write-only duplicates

**Confirmed (read-only):** `decompose` writes `code: notes.code`, `rfc: notes.rfc` **and** the whole `notes` object as `notes_extra` ([relational-map.js:73-76](../../src/lib/db/relational-map.js#L73)); `assemble` reconstructs the carrier from `notes_extra` only and **never reads `row.code` / `row.rfc`** ([relational-map.js:337](../../src/lib/db/relational-map.js#L337)). Whole-codebase grep: no reader of these two columns. They are pure write-only denormalized copies.

**Benefit of dropping:** removes a denormalized duplicate that can silently drift from the authoritative `notes_extra.{code,rfc}`; narrows the already-wide `carriers` table.

**Risk of not doing:** **Low.** They're inert (dead on read) — just storage noise + a latent drift trap if someone ever writes `code` without `notes_extra.code`. No correctness impact today.

**Reversibility:** `DROP COLUMN` is **destructive** but reversible **if the column values are backed up first** (they're trivially reconstructable from `notes_extra` anyway, so a backup table or a `select id, code, rfc` dump is enough). Re-adding = `ADD COLUMN` + backfill from `notes_extra`.

**Recommendation: DROP, with a value backup** (or, if you want SQL-level reporting on code/rfc, the opposite fix: make `assemble` read them and treat them as authoritative — but pick one, not both-and-ignore-one). Low urgency; bundle into the same reviewed migration as any future M2 work. Suggested safe sequence: `create table expressline._carriers_code_rfc_backup_20260625 as select id, code, rfc from expressline.carriers;` → `alter table … drop column code, drop column rfc;` → drop the `decompose` writes of `code`/`rfc` in code.

---

## D3 — `audit_logs`: dead table (no writer)

**Confirmed:** created in [db/index.js:86](../../src/lib/db/index.js#L86) (`audit_logs` with `actor/action/target/before_payload/after_payload` + a `bigserial` PK/sequence); **no `INSERT` anywhere** in `src/` or `scripts/`. 0 rows.

**Benefit of acting:** either gain a real audit trail (the schema clearly intended one — useful for the admin write routes / forensics on a shared multi-tenant DB), or remove scaffolding that misleads anyone assuming an audit trail exists.

**Risk of not doing:** **Low.** Empty and harmless, but an empty `audit_logs` is a false signal (someone may trust it for compliance/forensics and find nothing).

**Reversibility:** Wiring a writer is purely additive (reversible). Dropping the table + sequence is reversible by re-running the `CREATE TABLE` (the DDL is in code).

**Recommendation: WIRE A WRITER** (preferred) — the admin write routes already have natural before/after payloads; a thin `recordAudit()` in the store/route layer would populate it. If audit is explicitly not wanted, **DROP** `audit_logs` + `audit_logs_id_seq` and remove the `CREATE` from `migrateDatabase`. Either way, stop leaving it half-built.

---

## D4 — `quote_snapshots`: write-only telemetry

**Confirmed:** written on every generated quote ([workbench.js:374](../../src/routes/workbench.js#L374)); `listQuoteSnapshots` exists ([db/index.js:206](../../src/lib/db/index.js#L206)) but has **no caller**; PK index has 0 scans; 5 rows.

**Benefit of acting:** a usable quote history (audit of what was quoted to whom) + a retention/growth policy. Currently it accumulates forever with no read path and no cap.

**Risk of not doing:** **Medium-low.** Unbounded append-only growth on a shared-quota DB (slow, but real); the captured data is never surfaced, so it's pure cost today.

**Reversibility:** Fully reversible — adding a read surface and/or a retention job is additive; the table can also simply be left as-is.

**Recommendation: KEEP the table, add (a) a read surface** (an admin "recent quotes" view via the existing `listQuoteSnapshots`) **and (b) a retention policy** (e.g. keep N days / N rows, periodic prune). Low priority but cheap.

---

## D5 — enum CHECK + natural-key UNIQUE (data supports, but coupling)

**Verified clean (read-only, 2026-06-25):** `module_settings.module_key` distinct = `{__app__, customs, handover, inland, quote}` (subset of the planned enum); `container_types.rate_group` distinct = exactly the 12 `RATE_GROUP_NAMES`; and every candidate name column is **currently unique** (`carriers` 21/21, `customs_ports` 2/2, `customs_yards` 28/28, `inland_destinations` 44/44, `inland_origins` 1/1). So the data *would* accept these constraints today.

**Why NOT applied this round (despite data support):**
- **Enum CHECK on `container_types.rate_group`** would hard-couple the DB to `RATE_GROUP_NAMES` ([store/shared.js:17](../../src/lib/store/shared.js#L17)) — a **code constant that can grow**. A future 13th rate group would make a legitimate insert fail until someone also edits the CHECK. All 12 current values are already present, so the constraint adds rigidity with no headroom.
- **Enum CHECK on `module_key`** is safer (modules change rarely) but still couples the DB to a code list, and the relational store is now the live write path (a new module would fail in relational mode but not JSON mode — a confusing split-behavior footgun).
- **Natural-key UNIQUE on names** risks breaking **legitimate future duplicates** (e.g. two terminals named "Patio 1" under different ports, two carriers re-using a display name). The app keys everything by synthetic `id`; name uniqueness is not a real invariant. A *scoped* unique (e.g. terminal name unique within port) would be defensible but is more design than this pass warrants.

**Benefit:** DB-level rejection of an out-of-domain module/rate or a duplicate name.

**Risk of not doing:** **Low** (🟢 minor in the audit) — the app already validates these.

**Reversibility:** Trivial — `DROP CONSTRAINT`.

**Recommendation: HOLD.** The non-negativity CHECKs (applied) are domain-universal (a price is never < 0, ever); these enum/name constraints are **policy choices coupled to mutable code/data**. Apply only if you accept the maintenance coupling — and if so, prefer a **scoped** unique (name-within-parent) and keep the enum lists in **one** place (the code constant), regenerating the CHECK from it.

---

## D6 (PART 4) — auth not enforced + plaintext passwords — SEPARATE spec-first security project

**Not a DB-structure item — flagged here so it isn't lost, but it must be its own spec-first effort, not bundled with schema hardening.**

**Findings (confirmed, read-only):**
- **Login is not enforced.** `attachUser` and `requireAuth` both assign every visitor the frozen `publicDemoUser` with `role: "admin"` ([middleware/auth.js:17-25](../../src/middleware/auth.js#L17)) — every visitor has full admin access to frontend + admin rule editing. `GET /login` just redirects in.
- **Plaintext passwords.** `POST /login` compares `entry.password === password` against `getUsers()` ([core.js:29-31](../../src/routes/core.js#L29)); users live in `app_state['users']` (the legacy blob, **not** migrated to a relational table) as plaintext.

**Risk of not doing:** **HIGH** — there is effectively no access control, and the only stored credentials are unhashed. On a shared multi-tenant DB this is the most serious gap surfaced by the audit. (It is *not* a structural schema defect, which is why the structure audit graded it as out-of-scope context.)

**Reversibility:** n/a — this is net-new design.

**Recommendation: open a dedicated auth spec** (`docs/specs/YYYYMMDD_auth_IMPLEMENTATION_SPEC.md`) covering: real session-gated `requireAuth`, password hashing (bcrypt/argon2) + migration of existing users off plaintext, a relational `users` table (retire `app_state['users']`), and role/permission boundaries for admin routes. Per project rules, **auth/permission/password changes require spec-first** — do not patch piecemeal. Explicitly **out of scope** for this remediation round.
