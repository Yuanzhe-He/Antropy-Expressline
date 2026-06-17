# Project Lessons

Project-specific lessons, incidents, and reusable observations.

Do not use this as a daily changelog.
Only record lessons that may change future behavior.

## Entry format

## YYYY-MM-DD - Short title

- source_type: project-incident | ai-self-correction | user-feedback | test-failure
- task_type:
- domain:
- trigger:
- incident_or_feedback:
- lesson:
- scope: project | project-type | global-candidate
- landed_in:
- next_action:

## 2026-06-17 - Two normalizers for the same shape must stay in lockstep (parse vs store)

- source_type: ai-self-correction
- task_type: code-review / implementation
- domain: quote header + line-item normalization (server parse path vs store persist path)
- trigger: a deep re-read of batch1/2 found server.js parseQuoteHeader was updated to the new option sets (INLAND, new cargo types, transportMode) but store.js normalizeQuoteHeader was NOT — so a quote saved as a draft and re-read silently reset INLAND→OCEAN, new cargo→FCL, and dropped transportMode. The same gap existed in normalizeQuoteLineItem (missing section/unitOfMeasure/conceptEs).
- incident_or_feedback: when a value object flows through TWO normalizers — the request parser (server parseX, used for the live action) and the persistence normalizer (store normalizeX, used on load/save of drafts) — adding a field or widening an enum in one without the other creates a "works live, lost on round-trip" bug that no single-shot test catches. The PDF generated immediately looked correct; only save-draft→reload lost data.
- lesson: when you add/normalize a field on a request-parse path, grep for the matching store normalizer (`normalize<Same>`) and update both in the same change; add a draft/persist round-trip test (normalizeShippingData on a built object) asserting the new field survives AND that old objects get a back-compat default. Treat parse-vs-store as a pair.
- scope: project-type
- landed_in: batch3 P0 (store normalizeQuoteHeader) + S3 (normalizeQuoteLineItem section/uom/conceptEs); scripts/r2-batch3-test.js round-trips.
- next_action: for any quote/inland field change, update parseX + normalizeX together and add a normalize round-trip assertion.

## 2026-06-17 - Large autonomous multi-feature batch: commit-per-item + test-after-each + scope honestly

- source_type: ai-self-correction
- task_type: implementation / planning
- domain: Jose R2 batch1+batch2 (23 H/O/Q items across handover, customs, inland, quote)
- trigger: a single "do it all autonomously, questions at the end" mandate spanning two large batches.
- incident_or_feedback: the safe way to run a very large autonomous batch is one focused commit per H/O/Q item, each with a smoke/quote/targeted test run BEFORE committing, so a failure is localized and nothing is lost if context summarizes mid-run. Data-model changes (box_53, fixedCharges basis/required/amount, nameZh/nameEs, origins, unitOfMeasure/section, remark library) each went through the store normalizer with back-compat defaults + a focused round-trip test. A few items had genuine modeling ambiguity (per-point price override; remark drag-reorder; ES line-item concept) — these were implemented to a solid functional first pass and the scoped-down part was named explicitly rather than faked.
- lesson: for a big autonomous run — (a) keep a TodoWrite list and commit per item so progress survives a compact; (b) run the existing test (smoke/quote) after every item and extend it with a round-trip assertion for each user-facing fix (empty-cell-creates-rate, RCL add-tramo, add-port/delete-port, origin empty-shell, 4-language PDF); (c) when a sub-feature needs a product decision you can't make, ship the unambiguous 90% and state the deferred 10% in the commit + final report — don't block the whole run or guess silently; (d) when a smoke assertion encodes OLD behavior you intentionally changed (e.g. quote-settings bounce → real admin page; svg→png logo), update the test in the same commit.
- scope: project-type
- landed_in: PRs #6 (batch1) and the batch2 PR; commits r2-1a..r2-2b.
- next_action: reuse the commit-per-item + test-after-each rhythm for large batches; always name scoped-down sub-pieces explicitly.

## 2026-06-17 - Stacked-PR rebase-merge conflict recovery + re-verify stale plan premises against merged HEAD

- source_type: ai-self-correction
- task_type: deployment / planning
- domain: git PR merge workflow; spec-first investigation
- trigger: merging a clean linear stacked pair (PR#3 batch1→main, PR#4 batch2→batch1) then writing the next batch's spec.
- incident_or_feedback: (1) Rebase-merging the lower PR (#3) gave batch1 a NEW sha on main (fa6a7e0 ≠ 8088125); retargeting the upper PR (#4) to main then went CONFLICTING because files touched by BOTH batches 3-way-conflicted against the rebased base. (2) The execution plan's file:line refs and bug premises were written pre-batch2-merge and were partly stale: O6.7 VEHICLE_LABEL_KEYS was already fixed by batch2; "admin-module.ejs shared by handover+customs" was false (renderAdminRules sends customs→admin-customs.ejs, handover→admin-module.ejs); H4 add-set already seeds a first tramo; customs fixedCharges cells were already always-editable.
- lesson: (a) For a stacked pair, either merge-commit both (preserves SHAs, deterministic) or merge the lower PR then recover the upper WITHOUT force-push by cherry-picking only its incremental commits onto a fresh branch off the new main (verify `git diff --stat <orig-tip> HEAD` is EMPTY = byte-identical), close the conflicted PR, open a replacement. Don't rebase-merge a stacked lower PR if you then need the upper PR to retarget cleanly. (b) When the plan was authored before recent merges landed, re-verify every file:line and every "X is broken" premise against the actual merged HEAD before specifying changes — several "bugs" may already be fixed and several "shared" files may not be shared; report the corrections instead of coding to the stale premise.
- scope: project-type
- landed_in: docs/specs/20260616_batch1_fixes_SPEC.md (C1-C4 corrections); merge recovery via PR#5.
- next_action: prefer merge-commit for stacked pairs, or cherry-pick-onto-fresh-branch recovery; always diff the recovered branch against the original tip to prove content equality; open each batch spec by re-confirming line refs against HEAD.

## 2026-05-05 - Avoid Per-Option Admin Release Buttons

- source_type: ai-self-correction
- task_type: implementation
- domain: customs admin UI
- trigger: adding release controls for occupied shipping-line / container-type storage assignments.
- incident_or_feedback: the first implementation rendered one release button per occupied option and expanded the admin HTML payload to about 22 MB.
- lesson: for dense assignment matrices, avoid duplicating large option lists into secondary controls; render one compact control per card and derive its choices client-side from existing disabled options.
- scope: project
- landed_in: views/admin-customs.ejs, public/app.js
- next_action: when changing large admin matrix UIs, include a quick rendered HTML size or DOM-volume check before finalizing.

## 2026-05-06 - Persisted Defaults Need Migration

- source_type: user-feedback
- task_type: implementation
- domain: customs storage rules
- trigger: user reported that production still showed the old third storage tier after the default was changed to two tiers.
- incident_or_feedback: changing seed/default builders did not remove legacy persisted DB/runtime JSON state.
- lesson: when changing default rule structure, add a versioned normalization or migration path for existing persisted data, not just new drafts and repository seed JSON.
- scope: project
- landed_in: src/lib/store.js
- next_action: for future data-shape defaults, test against a fixture that simulates the old persisted shape.

## 2026-05-06 - Shared Mobile Chrome Must Check Admin In Spanish

- source_type: ai-self-correction
- task_type: implementation
- domain: workbench/admin responsive UI
- trigger: compacting the shared sidebar/header for the handover workbench.
- incident_or_feedback: browser regression found the Spanish `/admin/handover/settings` page had horizontal overflow because admin cards and tables could force a wider grid item.
- lesson: shared mobile chrome changes need admin-page checks in both supported languages, and grid/card wrappers should use `min-width: 0` so table overflow stays inside table cards instead of widening the page.
- scope: project
- landed_in: public/styles.css
- next_action: include Spanish mobile admin overflow checks when changing shared sidebar, header, cards, or grid wrappers.

## 2026-06-10 - Inland module: OSRM, link resolution, seed-data diff hygiene

- source_type: ai-self-correction
- lesson: (1) OSRM public routing needs a base-URL fallback chain + retries + serial spacing; `steps=true` gives ferry detection via `step.mode === "ferry"`. (2) Mexican tariff CSVs are often semicolon-delimited because `,` is the thousands separator — detect the delimiter from the header instead of hardcoding. (3) Google Maps link resolution must whitelist domains and follow short links manually (capped redirects, no cookies) to avoid SSRF; coordinate priority is `!3d!4d` > `@` > `q/ll` > `/dir` > bare text. (4) When `saveShippingData` runs full normalization, re-saving the seed JSON re-applies other modules' (idempotent) migrations and pollutes the diff — inject only the changed module section back into the HEAD file to keep PR diffs scoped.
- scope: project
- landed_in: src/lib/inland-routes.js, src/lib/inland-csv.js, src/lib/inland-link-resolver.js, data/shipping-lines.json
- next_action: when seeding/editing data files via the store, verify `git diff` is scoped to the intended module; reuse the OSRM fallback + delimiter-detection patterns for future data imports.

## 2026-06-11 - Inland finalize: real tarifario seed, encoding, same-key tiers, ferry

- source_type: ai-self-correction
- lesson: (1) CSV encoding must be auto-detected from the file Buffer — strict UTF-8 first (TextDecoder fatal:true), fall back to Latin-1, strip BOM — because operator re-exports from Excel are UTF-8/CP1252 and a hardcoded latin1 read mojibakes accented rows (e.g. CIUDAD ACUÑA) and silently drops them. (2) An idempotent rate-merge key of (destinationId,proveedor,cliente,commodity) is insufficient: the real data has two LTP rows for the GDL/Zapopan corridor identical on every column except price (29,000/43,000 vs 43,000/66,000). Fix = a file-order dupIndex appended to both the merge key and the id hash (also fixed a latent bug where the two rows produced the same entry id); size-1 groups keep dupIndex=1 so existing identities are unchanged; idempotency holds because same file -> same order -> same dupIndex -> in-place update. (3) Verify *post-merge final counts*, not just pre-merge produced counts, against acceptance. (4) The public OSRM car profile does NOT take the Mazatlán→La Paz ferry — it routes ~3614 km all-land down Baja — so step-mode ferry detection alone misses it; a road/straight-line detour-ratio (>2.5x) flags it cleanly and isolates only La Paz.
- scope: project
- landed_in: src/lib/inland-csv.js, src/lib/inland-routes.js, src/lib/store.js, scripts/seed-inland-from-csv.js
- next_action: when importing operator CSVs, decode by buffer with UTF-8→latin1 fallback; when deduping rows, confirm the chosen identity key actually distinguishes real-world rows and validate final counts; validate routing-engine assumptions (ferry/profile) against the live engine before encoding them as acceptance.

## 2026-06-13 - Inland go-live: confirm deploy target, seed must replace, scope the seed-file diff

- source_type: project-incident
- task_type: deployment / data-migration
- domain: inland go-live (merge feature/inland-routes-map to main + production Supabase seed)
- trigger: merge to main, deploy to antropy-expressline-production, then put the 300 real rateEntries into the production DB while removing any demo data.
- incident_or_feedback: four go-live gotchas. (1) The Railway deploy source was NOT inferable from the repo: no deploy config (no railway.json/toml, Procfile, nixpacks, Dockerfile), docs describe GitHub→Railway only generically, and the local `railway` CLI was linked to a DIFFERENT project ("MXQ Dashboard" → web-production-fa73d) with `railway list` returning Unauthorized — so the target service was neither visible nor controllable from here; the deploy mechanism (auto-deploy on push to main) had to be user-confirmed. (2) The task premised "12 demo rateEntries in prod", but a read-only check of the prod DB showed `modules.inland` EMPTY (0 rateEntries) — the demo seed never deployed because inland was never merged; always read the target before trusting the premise. (3) `scripts/seed-inland-from-csv.js` did an idempotent MERGE only, so it would have left demo + real coexisting; added a `--replace` flag that swaps `inland.rateEntries` wholesale. (4) Re-running `inland:seed` to propagate morelos/edomex `needsReview=false` rewrote the WHOLE shipping-lines.json (6k-line diff) because `saveShippingData` re-normalizes every module (handover/customs containerType + storage-ruleset migrations the committed seed was behind on) — exactly the diff-pollution from the 2026-06-10 lesson.
- lesson: before any go-live write — (a) positively confirm which Railway project/service serves the target domain and how it deploys (a generated `*.up.railway.app` host is its own service; don't trust the linked CLI project), and confirm the local `.env` DATABASE_URL is the prod DB by fingerprinting a distinctive live value (here: the handover line list incl. the "WHAN HAI" typo matched the live `/workbench/handover`); (b) read the target's current state before overwriting — premises about "demo data to delete" can be wrong; (c) make the seed REPLACE (not merge) so placeholder and real data can never coexist; (d) propagate catalog/destination metadata via a seed-version bump (gated re-seed), and when only one module changed, surgically patch just that module's section in the committed JSON rather than re-saving through the full normalizer (which migrates and reorders every module).
- scope: project
- landed_in: src/lib/inland-catalog.js, src/lib/store.js (INLAND_SEED_VERSION 2 + coordSource whitelist), scripts/seed-inland-from-csv.js (--replace), data/shipping-lines.json (surgical inland patch)
- next_action: reuse the fingerprint-the-live-value technique to confirm a `.env` points at prod before writing; keep `--replace` as the go-live seed mode; when editing one module in a store-managed JSON, patch in place to keep the diff scoped.

## 2026-06-16 - Inland v2 batch2: 6-tier vehicle types — label-map + seed-shape parity

- source_type: ai-self-correction (audit-found, pre-commit)
- task_type: feature / data-model extension
- domain: inland vehicle types (sencillo/full + 4 new tiers), routing-provider abstraction, case photos
- trigger: extending serviceType from a 2-value (sencillo/full) to a 6-tier enum.
- incident_or_feedback: a pre-commit audit caught two latent defects from the binary→enum widening. (1) `computeInlandCalculator`'s explanation text still used `serviceType === "full" ? serviceFull : serviceSencillo`, so ALL four new tiers (1.5t/3.5t/8t/lowboy) would render as "Sencillo" in the human-readable formula — the value math was correct, only the label was wrong. (2) `buildInlandDestinationSeed()` did not emit the new `imageUrls` field that `normalizeInlandDestination` adds, so seed-shape and normalized-shape diverged. Also confirmed by-design: burreo (short-haul) only has CSV data for sencillo/full, so new tiers compute burreo=0 until José provides per-tier data.
- lesson: when widening a binary discriminator to an N-value enum, grep for EVERY `=== "<oldvalue>" ? ... : ...` ternary that branches on it (labels, formulas, sort keys, map-data), not just the price lookup — the math is the obvious site, the human-facing label is the easy miss. And when adding a normalized field, add it to the seed builder too so seed-shape == normalize-shape (otherwise the first re-seed silently changes the object shape). Verify replace_all actually hit all occurrences — identical strings at different indentation are distinct matches.
- scope: project (label-map technique is a cross-project candidate)
- landed_in: src/lib/calculate.js (VEHICLE_LABEL_KEYS + vehicleLabel), src/lib/store.js (buildInlandDestinationSeed imageUrls), src/lib/inland-vehicles.js (catalog)
- next_action: on the next enum widening, sweep all branch sites; keep seed builders in lockstep with normalizers.
