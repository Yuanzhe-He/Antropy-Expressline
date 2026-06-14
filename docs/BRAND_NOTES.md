# Brand Notes

Project-specific brand, tone, visual identity, and content preferences.

Keep brand-specific facts local.
Only extract global rules when they apply across projects.

## Current Brand / Product Fit

- Source: `README.md`; project uses a black, white, and gray frontend/admin style.
- Source: `README.md`; product serves logistics cost calculation and admin rule maintenance.
- Source: `README.md`; app supports Chinese / Spanish language switching.
- Source: `docs/product-uiux-audit.md`; this should feel like an enterprise logistics operations workbench, not a generic SaaS landing page.

## Local Guidance

- Prefer dense, scannable, work-focused layouts.
- Keep logistics terms and concrete module context visible.
- Avoid oversized hero treatment on internal workbench screens.
- Use brand specificity from logistics, shipping lines, customs, yards, containers, exchange rates, and quote workflows.

## 2026-06-13 - Quote Document (Cotización) Brand Spec

The generated quote PDF (`views/quote-document.ejs`) is a **co-branded, bilingual
EN+中文** document, intentionally decoupled from the app's ZH/ES UI i18n.

- **Header (dual logo):** Express Line Corporation logo on the **left** (must
  include its "Service Guaranteed" sub-bar), DE WELL GROUP logo on the **right**.
  Both lockups carry equal visual weight in the document header (this is a
  customer-facing co-brand, distinct from the in-app DEWELL-primary treatment).
- **Footer:** `Express Line Corporation` wordmark on the left; **IATA** + **C-TPAT**
  marks on the right.
- **Accent color:** corporate navy band (`#2f3b8c` / `#3b4ab0`) for section
  headers (GENERAL DATA / MEXICO LOCAL CHARGES / NOTES) and the charges table head.
- **Logo assets** live in `public/`: `express-line-logo.png`, `iata-logo.png`,
  `ctpat-logo.png` (Chandler provides), plus existing `dewell-logo.svg`. If any
  file is missing the document renders a labelled `(logo pending)` placeholder
  box rather than failing — replace placeholders before sending quotes to clients.
- **Fonts:** Noto Sans (Latin) + Noto Sans SC (CJK) are embedded via `@font-face`
  (base64) so Chinese concept names never render as tofu, independent of host
  fonts. `public/fonts/NotoSansSC-Regular.woff2` is a CJK-range subset (~4.2MB).
- **CONCEPT cells** are two lines: English (bold) over 中文.

## 2026-05-06 - Workbench Brand Treatment

- Use the DEWELL logo as the primary customer-facing brand mark for the workbench surface.
- Keep Antropy AI secondary in the first viewport; it should not compete with the DEWELL mark.
- Express Line can remain as product/workbench context where useful, but it should not overpower the DEWELL brand treatment.
- For favicon polish, use a simplified DEWELL-derived mark rather than introducing a new symbol.
