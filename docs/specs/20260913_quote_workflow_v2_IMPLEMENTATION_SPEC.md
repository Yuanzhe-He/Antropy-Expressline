# Quote workflow v2

Source: Chandler's 2026-09-13 follow-up (changes 2–6), attached fee-table/UI
screenshots, and explicit confirmation to compare raw kg and cm³ numbers.
Work stays in this independent clone and PR branch; the original Cursor folder
is read-only. Test and push are authorized. No message to Bill or production
configuration write is requested.

## Behavior

1. Quote header stores importerQualification (own/trading_company/blank),
   specialImportQualification, nomCertification, ministryRegistration
   (yes/no/unknown/blank). These are user answers, not legal determinations.
2. Cargo mode appears with quote scope at the start. Initial supported choices
   become FCL, LCL, BBK. Retire other current choices once without erasing old
   draft codes. Explicitly empty configured lists remain empty on subsequent reads.
3. FCL supports multiple container-type/count/unit-price/currency rows. LCL/BBK
   supports package rows with dimensions cm and count, unit weight kg and count,
   plus a unit price/currency. The confirmed formula is raw
   `max(sum(lengthCm*widthCm*heightCm*packageCount), sum(weightKg*weightCount))`
   multiplied by unit price. Display both totals and the selected raw basis.
   No dimensional-weight divisor is introduced. Active incomplete inputs cannot
   generate a numeric charge; explicit zero is distinct from blank.
4. Separate fixed charges from charges-if-incurred. The latter display reference
   unit prices/ranges and conditions but never enter payable subtotals or tax/FX
   totals. Preserve geographic section (Mexico/foreign) independently.
5. Add editable fee templates to admin (add/edit/disable, group, fixed/contingent,
   names, units, ranges, currency, applicability and remarks). Seed all 14 visible
   source rows. Alternative Single/Full transport and source-conditional suggested
   fees require explicit selection to avoid automatic double billing.
6. Currency defaults are per fee category: SHIPPING LINE USD, all other categories
   MXN. Explicit source/template/operator currencies are respected. New rows and
   category changes use the saved defaults.
7. Rename custom-field label/value controls clearly. Condense fee rows: primary
   language name visible, translations expandable; small checkboxes, compact
   aligned cells and neutral surfaces. Preserve entered fields when mode changes.
8. Produce an Excel review file with fee and existing-five-clause sheets, editable
   Bill feedback columns, exact source ranges/remarks and identified source gaps.
   Archive both original screenshots unchanged with a source transcription.

## Data/API contract

- `quote.settings.feeTemplates`, `feeTemplateConfigVersion`,
  `defaultCurrencyByCategory`, `cargoTypePolicyVersion`: existing settings JSONB.
- Each fee row adds `chargeKind`, `unitPriceMax`, `appliesTo`, `enabled`,
  `selectionRequired`. Explicit empty fee templates must not reseed.
- Quote headers retain the four customs answers and cargo-name snapshots.
- `draft.cargoPricing` is stored via existing draft header JSONB so no DDL is
  required; hydrate it consistently for JSON and relational roundtrip.
- `public/quote-pricing.js` is the same pure calculation engine used server-side
  and by the browser. `src/lib/quote-config.js` owns reference templates.
- Existing admin POST and quote/PDF POST carry the new form fields. Server
  validates templates and active cargo input; disabled/unknown modes stay invalid.
- Automatic cargo charge rows, when entered, are calculated server-side and
  included once; stale browser-computed values are never trusted.

## Ownership and verification

Domain helper agent: two new pure modules. UI agent: quote workbench view/JS/CSS.
Workbook agent: source archive and Bill file. Root: settings/routes, normalization,
PDF, integration and regression tests. No overlapping file edits.

Test customs persistence/PDF, FCL mixed types, LCL/BBK weight/volume/count/blank/
zero/overflow, mode changes, template CRUD/default currencies/ranges, exclusion of
contingent fees from every total, JSON/relational roundtrip, legacy history and
UI interactions. Run the full existing suite and focused new tests, inspect
desktop/mobile UI and workbook renders, then push and read back the PR head.
Preserve fee formulas outside the explicitly changed quote workflow, existing
notes and auth/session behavior. No schema or runtime flag changes.


## Validation and review handoff

- Complete regression: 25/25 suites passed. New workflow regression: 26/26 checks passed. Later PDF footer adjustment rechecked quote-test, PDF lifecycle and real HTTP smoke suites; later currency parsing rechecked the workflow suite.
- Browser: desktop and390px mobile; native16px checkboxes; FCL2x100+3x50=350USD; LCL/BBK max(200kg,12000cm3)x0.5=6000MXN; inactive decimal inputs and all cargo values survive draft save. Configured conditional12.50-20USD row appears after admin save without changing subtotal.
- Real PDF render: FCL2pages and LCL1page, all pages visually checked; native page-margin footer also verified on both FCLpages.
- Bill workbook: companion outputs/2026-09-13_quote_v2_bill_review/ExpressLine_2026-09-13_Bill_Review.xlsx, sheets费用核对 and附加条款.14visible fee rows plus5current live notes; Bill feedback columns. No message sent toBill.
- The live first VAT clause differs from repository fallback; recorded forBill without overwriting production settings. Source rate/quantity ambiguity remains explicitly marked in the review workbook.
- Both original screenshots and transcription are archived under docs/client-info-source/original-docs/. No productionDB write, migration, merge or deployment performed by this task.
