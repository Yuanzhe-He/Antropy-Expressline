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
