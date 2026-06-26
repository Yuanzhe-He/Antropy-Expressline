# Cross-Project Database Layout — one Supabase project hosts 3 businesses

- Date: 2026-06-25 (census re-run 2026-06-26 post PR #32/#34 merge)
- Supabase project ref: **`polxyashvxbzdkkmxuox`** (assertProd target)
- Method: **READ-ONLY census** of `pg_catalog` / `information_schema` — **schema + table NAMES only**. No row data of `joyas_*` / `punas_*` was read; no column structure of other projects was enumerated; **nothing non-`expressline` was modified**. Cross-project reference checks read constraint metadata only (which table references which), not other projects' data.
- This is a one-time authorized boundary census. **The standing iron rule is unchanged: this repo's tooling only touches the `expressline` schema; `joyas_*` / `punas_*` are never read (data) or modified.**

## The three tenants

This single Postgres instance (Supabase project `polxyashvxbzdkkmxuox`) hosts **three independent businesses**, each a separate app with its own deploy:

| Project | Business | Isolation mechanism | How to recognize its tables |
|---|---|---|---|
| **Express Line** | Logistics cost workbench (this repo) | **Dedicated schema** `expressline` | anything in the `expressline` schema |
| **Althea** | Jewelry marketing / content / asset platform | **`public` schema, `joyas_` prefix** | `public.joyas_*` |
| **pang uñas** | Nail-salon appointments / POS | **`public` schema, `punas_` prefix** | `public.punas_*` |

**Two different isolation strategies coexist:** Express Line uses a true **dedicated schema** (the strongest boundary — separate namespace, per-schema role grants, `search_path` scoping); Althea and pang uñas share the **`public` schema** and separate only by **table-name prefix** (a naming convention, not a hard boundary).

## Separation cleanliness — VERIFIED CLEAN ✅ (2026-06-26)

| Check | Result |
|---|---|
| Every business table classifiable to exactly one project? | ✅ **Yes** — 51 business tables, **0 unknown** |
| `public` tables all prefixed consistently (`joyas_`/`punas_`)? | ✅ **Yes** — 0 unprefixed, 0 misspelled (all 18 `joyas_`, all 12 `punas_`) |
| Any FK crossing between the 3 business projects? | ✅ **None** (`expressline`↔`joyas`↔`punas` never reference each other) |
| Any FK touching `expressline` that leaves the schema? | ✅ **None** — `expressline` is FK-isolated |
| Any business views referencing across projects? | ✅ **None** — `expressline` and `public` have **0 views** |

FK edge summary (whole DB): `expressline→expressline` 12 · `joyas→joyas` 19 · `punas→punas` 11 · `punas→auth.users` 6 (Supabase Auth — pang uñas's own integration, not a cross-business reference) · `auth→auth` 18 · `storage→storage` 5. **No business project references another.**

**Conclusion: the separation is clean and is hereby recorded as the verified standard.** No remediation needed; no rename/move performed or required this round.

---

## Full table census (names only)

### Express Line — schema `expressline` (21 tables)
18 relational entity tables + 3 aux. Full per-table detail: [DATABASE_SCHEMA.md](../DATABASE_SCHEMA.md).
```
app_state            audit_logs           carrier_local_charges  carriers
container_types      customs_ports        customs_terminals      customs_yards
exchange_rates       inland_destinations  inland_origins         inland_rate_entries
inland_route_cache   module_settings      quote_drafts           quote_notes
quote_snapshots      terminal_charges     yard_carriers          yard_charges
yard_ports
```

### Althea — `public.joyas_*` (18 tables)
*(Groupings inferred from table names only — no columns read. Jewelry marketing / AI-content / asset-management platform.)*
- **Products:** `joyas_products`, `joyas_product_images`
- **Marketing & performance:** `joyas_marketing_campaigns`, `joyas_marketing_calendar`, `joyas_marketing_assets`, `joyas_campaign_assets`, `joyas_budget_targets`, `joyas_performance_daily`, `joyas_post_templates`
- **Asset library:** `joyas_asset_products`, `joyas_asset_references`, `joyas_asset_tags`, `joyas_asset_usage_logs`, `joyas_variant_assets`
- **AI prompt system:** `joyas_prompt_families`, `joyas_prompt_variants`
- **Ops:** `joyas_data_import_jobs`, `joyas_audit_logs`

### pang uñas — `public.punas_*` (12 tables)
*(Groupings inferred from table names only — no columns read. Nail-salon appointments / POS. Integrates Supabase Auth: 6 FKs `punas_*→auth.users`.)*
- **Customers & staff:** `punas_customers`, `punas_staff_profiles`
- **Appointments:** `punas_appointments`, `punas_appointment_services`
- **Services:** `punas_services`, `punas_service_alias_suggestions`
- **Orders / POS:** `punas_orders`, `punas_order_items`
- **Balance / payments:** `punas_balance_adjustments`, `punas_topups`, `punas_rights`
- **Voice:** `punas_voice_logs`

### System / Supabase-managed schemas (not business)
`auth` (23, Supabase Auth) · `storage` (8, Supabase Storage) · `realtime` (3) · `vault` (1) · `extensions` (2 views) · `graphql` / `graphql_public` / `pgbouncer` (0) · plus `pg_catalog` / `information_schema`. None contain any of the 3 projects' business tables.

---

## Iron rule for this repo's tooling

- **Only `expressline`.** Every script here is schema-qualified to `expressline` and gated by `assertProd` (`ref == polxyashvxbzdkkmxuox`, [scripts/relational/prod-guard.js](../../scripts/relational/prod-guard.js)) + the restricted `expressline_migrator` role for writes. `joyas_*` / `punas_*` are **never read (data) or modified** — touching them would affect the Althea / pang uñas apps.
- Shared-instance reality: the three tenants share one Postgres instance → **shared connection limits, egress, CPU, storage quota** (the egress storm that blew the free tier was a shared-quota event). Isolation is logical, not resource-level.

## Long-term recommendation — prefix-in-`public` vs dedicated schema

**Dedicated schema-per-project (Express Line's model) is the more robust pattern**, for reasons the prefix approach cannot match:
- **Hard namespace boundary** — a role can be granted on one schema only (Express Line's `expressline_migrator` literally cannot see `joyas`/`punas`); in shared `public`, any role with `public` access sees **both** Althea and pang uñas.
- **No prefix-typo risk** — a mistyped/missing `joyas_`/`punas_` prefix silently orphans a table (today there are none, but it's a standing footgun); a schema has no such failure mode.
- **Cleaner `search_path` scoping** and per-schema backup/migration.

**However, migrating `public.joyas_*` → `joyas.*` and `public.punas_*` → `punas.*` is a big, app-affecting move**: it requires changing the **Althea and pang uñas apps** (their `search_path` / table references / ORM config) in lockstep with the rename, plus their own migration + verification. That is **out of scope for this repo** and must be each project owner's decision.

**Net:** the current layout is clean and safe as-is — no action required. If the tenants are ever consolidated or hardened, **follow Express Line's dedicated-schema model** rather than adding more `public` prefixes. Do **not** rename/move `joyas_*`/`punas_*` from this repo — it is not ours to change.
