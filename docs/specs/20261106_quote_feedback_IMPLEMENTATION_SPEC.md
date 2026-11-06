# November quotation feedback implementation

Chandler explicitly authorized implementation, push and an annotated copy of Bill's document on 2026-11-06. Work uses the existing independent Codex checkout on `feat/quote-nov04-feedback`, based on `origin/main` fa69488. The original Cursor checkout remains untouched. This scope does not request production configuration writes, merging, or sending a message to Bill.

## Decisions

1. Rename FCL every-container input to per-container transport charge, explicitly included in the total. Warn against entering the same service in the manual fee table; preserve independent transport services.
2. Keep stable shipment value and improve readable bilingual unit labels without replacing arbitrary units.
3. Add optional CUSTOMS CLEARANCE templates UVA, Trade Agency Service Fee and Overweight surcharge with blank prices. Deduplicate existing custom entries by stable ID/concept, preserve explicit empty libraries, disabled items, drafts and edited prices. Use a one-time additive configuration version, not full template reseeding.
4. Add priceType (`amount` or `percentage`), percentageRate and cargoValue to single quote fees. Cargo value means the entered commercial-invoice goods value, excluding freight, insurance and taxes; its currency is the fee currency. Display that basis explicitly. Percent fees equal cargoValue × percentageRate / 100 once, never multiplied again by container/quantity. Empty cargoValue yields a visible pending amount, not zero. Explicit zero is distinct. Support rate-only cells in long-term rate cards; rate-card alternatives never aggregate into a shipment total. Percent with AT COST/ranges is not a silent coercion. Share calculation between browser and server.
5. Add mexico_included tax treatment, with wording scoped to Mexico fixed quoted charges. Input prices remain selling prices and never automatically gain VAT. Filter mutually contradictory general tax clauses on output when an explicit treatment is chosen; preserve saved business clauses. New quotes default to Mexico included; historical drafts preserve their prior setting.
6. Undo deleted fee rows in the current page editing session, restoring complete row values and order. Keep add-from-catalog distinct. UI explains that refresh ends undo history.
7. Use the supplied stamp image verbatim, with a saved include-stamp switch (new quotes on; historical quotes retain previous no-stamp behavior). Put it once in document flow after notes, never over data or in repeated page footer.
8. Save customerCode, salesCode and revision with the quote. Output customer-code / salesperson-code / quotation serial / vNN, retain existing numbering and meaningful internal/rate-card suffixes. Same-version re-export never increments revision; provide explicit revision control. Preserve old quote fallback until codes are supplied. Validate code characters rather than inventing customer identities.

## Implementation and ownership

- Core agent: shared percentage engine, quote totals/config/normalization, new fee templates, pure rate-card model; targeted regression tests.
- UI agent: workbench and fee/admin partials, browser quote/rate-card/admin editor JS, quote CSS; percentage controls, shipment, tax/stamp/naming inputs, undo.
- Export/integration agent: form parsing and view assembly, quote routes, PDF template/assets, export naming and tax/stamp resolution; targeted integration tests.
- Root: coordinate interfaces, validate final diff/tests/UI/PDF, extract provided stamp, author DOCX replies, commit/push and verify remote.

## Contract

Single-fee fields: priceType, percentageRate, cargoValue; posted as li_priceType[], li_percentageRate[], li_cargoValue[]. Percentage base uses row currency. Rate-card cell fields: priceType, percentageRate; rate-card percentages are descriptive and do not use shipment cargo values. Header controls: customerCode, salesCode, revision, taxTreatment, includeStamp. New tax enum: mexico_included. Existing data remains compatible through defaults.

## Verification and rollback

Run pure fee cases (blank/zero/8%/invalid/overflow/AT COST/contingent), form and draft roundtrip, existing relational JSONB roundtrip without live DB, rate-card and PDF suites, then full scripts/run-all-tests.js with JSON storage. Use synthetic local JSON state, disable live FX refresh and production DB access. Inspect desktop/mobile UI, edited row undo, source DOCX replies and all rendered document pages. Verify new branch head after push; do not force push or merge main.

Affected surfaces: single quote, long-term rate card, admin fee catalog, draft/PDF routes, optional quote header and fee JSON fields. No auth changes, database DDL or production env changes. Rollback is code revert; retained old fields and optional new fields should remain readable. No reset/seed of production data.

## Verified implementation

- Full regression: 35/35 suites passed with JSON storage and live FX disabled. New percentage, export and real-browser suites cover the feedback; existing RMW-cache and relational JSONB roundtrip suites remain green.
- Browser: single percentage 8% of MXN100000 = MXN8000 independently of quantity5; missing/zero bases, exact delete undo, native draft save/reopen, stable named PDF re-export, mobile390px containment, and no runtime errors. Additional real-browser QA verified long-term8% cell save/reopen and row undo, plus admin12.5% template POST/reopen.
- PDF: inspected a portrait single-shipment example and two-page landscape rate-card example. Percentage/basis labels, scoped VAT, one final stamp, no repeated stamp or clipped table content. Synthetic demonstration data only.
- Review fixes preserve invalid raw percentage fields and their errors across failed export/save/reopen until explicit correction; tax filtering removes conflicting general tax sentences without deleting origin-tax, insurance, payment or FX terms. Auto numbering skips already occupied serials.
- Number allocation is serialized within one app process and persists draft/editor identity after successful PDF creation. This is not a multi-instance database sequence guarantee; no production configuration changes were made.
- [SELF_CORRECTION] Unified blank/default rate-card property order after the RMW regression detected a spurious full-blob save. Added byte-idempotence regression and a local guardrail.
- [SELF_CORRECTION] Follow-up PDF review found that the standalone sentence "A 16% VAT will be added at invoicing" survived the tax filter. Recognize its leading article, assert removal of both conflicting clauses while preserving insurance/origin conditions, and recheck the generated PDF. Targeted export tests and the full 35-suite regression pass after the correction.
