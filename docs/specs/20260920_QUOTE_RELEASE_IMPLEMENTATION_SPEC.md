# Quote release: selectable cargo workflows and customer/internal output

Source: Chandler's 2026-09-20 messages, screenshot of the old live page, and pasted Bill/Chandler meeting summary. The user authorized implementation, tests, push and completion of the previously discussed release. Meeting prose is requirements evidence, not authorization to send messages. Work occurs only in the isolated Codex clone; the original Cursor checkout remains read-only.

## Scope and contracts

- Put loading/transport service selection beside quote scope at the top. Support FCL, LCL, BBK, AIR. Each selection changes relevant cargo input, pricing method and applicable fees; preserve each mode's entries while switching and when reopening drafts.
- FCL: multiple container types, quantities and per-container prices. Other modes: package dimensions/counts/weights, optional automatic pricing or manually entered chargeable quantity. Cargo description without a transport price must not prevent manual fee quotes.
- Retain the explicitly approved raw numeric max(kg, cm3) method for LCL/BBK as a selectable rule. AIR defaults to manual chargeable weight; no invented divisor or tariff. Per-type default methods and optional positive volumetric divisor are editable in admin. BBK supports individually priced truck/flat/shipment fee lines.
- Shared cargo-pricing fields: existing containers/packages/unitPrice/currency plus method (raw_max, volumetric, manual), manualChargeable and volumeDivisor. Per-type saved state: cargoPricingByType on the quote header; active cargoPricing remains backward compatible. Backend settings: cargoPricingRules keyed LCL/BBK/AIR with method and volumeDivisor. Legacy LCL/BBK data keeps its existing method; defaults affect new calculations.
- Admin: four modes with enabled labels, applicable fee modes, editable official business fee code, price/range/unit/currency, fixed/contingent fees and terms. Preserve saved custom settings. Rename the default shipping-line local fee to Shipping line local charge without rewriting historical quotes or unrelated delivery-order fees. Generated IDs are not official company codes.
- Customer PDF hides fee codes. Internal export may show the code column immediately after the first classification column. Existing workbench code moves near the beginning. Customer PDF has a per-quote showTotals checkbox default false, saved in drafts and snapshots. It controls every bottom subtotal/conversion/tax summary; per-line prices and amounts remain visible.
- Prices carry an explicit per-quote tax treatment (unspecified, included, excluded). No automatic tax addition to already included prices. The default customer summary shows original-currency subtotals; no hidden extra tax or inferred conversion. Existing historic snapshots remain intact.
- Preserve four customs questions, fixed vs contingent split, small checkboxes, compact fee rows, useful custom-field labels, editable note library and source archives from the existing branch.

## Validation and release

- Regression: core tests plus quote/cargo/config/draft/PDF cases. Cover all modes, independent switching, persistence, manual quotes with partial cargo info, raw and configured volumetric formulas, invalid divisor/price handling, totals default off/on, customer/internal code visibility and included-tax amounts.
- Browser: actual top-level selector, all mode panels, fee filtering, admin save/reopen, draft roundtrip and compact layout. Render representative customer and internal PDFs and inspect them.
- Use PR branch workflow; no force push or production seeding. Verify deployed revision and actual live page independently of local/branch success. If external deployment access blocks completion, report the exact verified state.

## Remaining business inputs

Bill can populate official fee code mappings, approved prices/clauses, and AIR tariffs in admin; no fabricated values. Multi-container layout uses the existing editable rows until Bill supplies an alternative layout. The screenshot's double-truck amounts/quantities remain explicit and editable, not silently reinterpreted.
