# Migration COMPLETE — `app_state` blob → relational (Steps 1–8)

Date: **2026-06-25**. Status: **✅ MIGRATION 100% CLOSED** — prod live on relational; the frozen blob is
retired (reversibly). **No code work remains**; only the optional/manual items in "Remaining items" below.
Companion to [20260622_blob_to_relational_CUTOVER_RUNBOOK.md](20260622_blob_to_relational_CUTOVER_RUNBOOK.md) (full per-step execution records).

## Final prod state (verified 2026-06-25; last CODE change = PR #29, all later deploys are docs-only no-ops)
- **Railway**: project `courteous-courage`, service Antropy-Expressline, ● Online, `/healthz` 200 (verified across deploys ef4f715f → 65c37f45).
- **`STORAGE_MODE=relational`** — the 18 per-entity tables are the live read **and** write source.
- Row counts stable at the cutover baseline (carriers 21, customs_yards 28, inland_destinations 44,
  inland_rate_entries 300, container_types 20, quote_notes 5, module_settings 5; **baseline drift NONE**).
- **`expressline.app_state` = exactly `{ shipping-data-retired-20260625 (rev 215132), users }`** — no live
  `shipping-data` key. `shipping-data-retired-20260625` is the frozen pre-cutover blob, kept as a rollback anchor.
- badRuleSets = 0 across all 21 carriers; usage-guard no alerts; cache_hit ~100%; no egress anomaly / 0×402/5xx.
- **joyas/punas schemas: zero contact** throughout the migration.

## Step checklist (1–8)
| Step | What | State |
|---|---|---|
| 1 | Backup expressline (app_state + audit_logs + quote_snapshots) | ✅ Phase-0 `backups/prod-cutover-2026-06-24T03-34-46-938Z/` |
| 2 | Create 18 relational tables (restricted migrator role) | ✅ |
| 3 | Forward migrate blob→tables + Q4/Q5 gates + DROP 8 dangling refs | ✅ parity=0 |
| 4 | Parity gate (blob projection vs table projection = 0) | ✅ |
| 5 | Deploy `STORAGE_MODE=dual` (write both, shadow-diff) | ✅ |
| 6 | Deploy `STORAGE_MODE=relational` (live) | ✅ |
| 7 | Per-entity route writes (2b) | ⏸ **DEFERRED** (see below) — relational per-entity writes are active at the store layer; the ~60 admin route call-sites are not yet swapped |
| 8 | Retire frozen blob | ✅ 2026-06-25 reversible rename → `shipping-data-retired-20260625`; + symmetric blob/dual seed guard (**PR #29**) |

## Rollback path (current)
A bare `STORAGE_MODE=blob` flip is **no longer a rollback** — the `shipping-data` key was retired, and (since
PR #29) the blob/dual read path **fails loud** rather than seeding demo data over the live tables. To roll back:
1. `node scripts/relational/prod-reverse-to-blob.js --apply --i-understand-this-overwrites-the-live-blob`
   — rebuild the live `shipping-data` blob from the **current** relational tables (lossless, round-trip-verified), then
2. `railway variables --set STORAGE_MODE=blob`.

Alternatives: `node scripts/relational/retire-blob.js --revert` (restore the cutover-era frozen blob verbatim
under `shipping-data`), **Supabase PITR**, or the **Phase-0 raw backup**.

## Two deliberate deferred items (with triggers)
1. **Hard DROP of `shipping-data-retired-20260625`** — the **only irreversible** action. Deferred to a longer
   stability window, or never. Trigger: Chandler 100% comfortable + a long quiet period. Until then the row is the
   cheapest in-DB rollback anchor (`retire-blob.js --revert`).
2. **Step 7 — route-layer per-entity writes** — swap the ~60 admin write routes from whole-module
   `saveShippingData`/`saveModule` to per-entity `saveCarrier`/`saveCustomsYard`/`saveInlandRateEntry`.
   **Trigger: BEFORE scaling beyond a single app instance.** Today the single-instance deployment + write-through
   cache-invalidation discipline already blocks the cross-edit clobber that per-entity writes would harden against;
   the per-entity store methods exist and fall back safely, so the swap is incremental when needed.

## Obsolete cutover-era scripts (do NOT delete; superseded)
These flip `STORAGE_MODE=blob` or assume a live `shipping-data` key — valid DURING the cutover, now stale because
the blob is retired. The PR #29 seed guard makes any blob/dual `getShippingData()` **fail loud** instead of
re-seeding, so they are safe-but-obsolete:
- `scripts/relational/prod-write-roundtrip.js` — its FX-freshness sub-check flips to blob mode; would now throw the
  seed guard (it re-seeded a stray key last round, before the guard existed).
- `scripts/relational/prod-dryrun-facade.js` — pre-cutover facade dry-run (blob mode).
- `scripts/relational/prod-D-shadow.js` — dual-phase shadow compare (blob mode).
- `scripts/relational/read-prod-blob.js` — reads the raw `shipping-data` key directly (now absent → returns null).
- `scripts/relational/prod-0{3,4}-*.js`, `prod-99-final-verify.js` — Step 3/4 cutover-phase tooling.

**Still current (NOT obsolete):** `prod-reverse-to-blob.js` (rollback WRITE path), `retire-blob.js` (`--revert`),
`app-state-inventory.js`, `export-app-state-row.js`, `cleanup-stray-shipping-data.js`, `prod-verify-seed-guard.js`,
`prod-read-demurrage.js`, `prod-health-check.js`.

## Sandbox cleanup
The migration sandbox Supabase project `fnczokogchlhutyskbdw` (`expressline-mig-sandbox`) has served its purpose
(2a→2b parity / integration 9/9 / concurrency 5/5 all proven there). It is now **safe to delete — Chandler's call;
not done this round.** The local `supabase/.temp/` still points at it and is now **gitignored (PR #30)**, not committed.

## Remaining items (none are bugs; none affect the running system)
The migration itself is closed. Everything below is optional or non-code.

**Deliberately parked (engineering, with triggers)** — detailed above:
- (a) **Hard DROP of `shipping-data-retired-20260625`** — the ONLY irreversible step; a longer stability window, or never.
- (b) **Step 7 — route-layer per-entity writes** — before scaling beyond a single app instance; the single-instance
  deployment + write-through cache-invalidation discipline blocks the cross-edit clobber today.

**Chandler manual decisions / follow-ups:**
- **Sandbox deletion** — Supabase `fnczokogchlhutyskbdw` (`expressline-mig-sandbox`) is safe to delete (not done this round).
- **Client docs tracking** — `docs/client-info-source/*` (chandler logs, jose meeting notes, CONTENTO pricing) and the
  3.4MB `TARIFARIO 15.06.26.xlsx` were **intentionally left untracked** this round; whether to version-control them is
  Chandler's call (repo read-access / ownership question).
- **Business follow-up (José / Estefani)** — the legacy bad demurrage rule sets meant **WHAN HAI and OOCL quoted $0
  demurrage** at every dwell day (billing tiers were unreachable — a revenue leak). Fixed + deployed (PR #25/#26,
  2026-06-24). José/Estefani should be told: **historical quotes for those two carriers under-charged demurrage;
  future quotes now include it** — a customer comparing an old quote to a new one will see the demurrage line appear.
  Not a regression; the old $0 behavior was the bug.

**Obsolete-but-safe cutover scripts** — listed above; left in the tree (now fail-loud via the PR #29 seed guard), not deleted.

## Repo tracking status (2026-06-25, after PR #30)
Everything that should be version-controlled now is: Step 8 tools + seed guard (PR #29); closeout records + project/spec
docs + AI-workflow reports + agent rules (`AGENTS.md`/`CLAUDE.md`/`.ai/`/`.cursor/`) + tariff CSV (PR #30);
`supabase/.temp/` gitignored. The ONLY untracked items left are the deliberately-deferred `docs/client-info-source/*`
client docs + the 3.4MB xlsx (Chandler's decision). No other dev/project artifact is uncommitted.
