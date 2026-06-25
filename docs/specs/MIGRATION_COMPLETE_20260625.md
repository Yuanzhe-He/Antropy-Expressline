# Migration COMPLETE — `app_state` blob → relational (Steps 1–8)

Date: **2026-06-25**. Status: **DONE — prod live on relational; the frozen blob is retired (reversibly).**
Companion to [20260622_blob_to_relational_CUTOVER_RUNBOOK.md](20260622_blob_to_relational_CUTOVER_RUNBOOK.md) (full per-step execution records).

## Final prod state (verified 2026-06-25, after PR #29 deploy `ef4f715f`)
- **Railway**: project `courteous-courage`, service Antropy-Expressline, deploy `ef4f715f`, ● Online, `/healthz` 200.
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
not done this round.** The local `supabase/.temp/linked-project.json` still points at it and should be gitignored,
not committed.
