# Editable quote cargo types

## Confirmed scope

Source: Chandler's 2026-09-13 request and approval to implement, test, and push.
The existing eight cargo-type choices contain terms that operators find unclear.
Manage the list in quote rule settings: add a code and display name, rename the
display name, and enable/disable entries. Saving confirms the configuration;
only enabled entries are selectable in a new quote. No separate approval role.

## Data and compatibility

- Store `settings.cargoTypes` as ordered `{ code, label, enabled }` entries in
  the existing quote module settings JSON. No table migration or production seed.
- Codes are stable identifiers (1–32 ASCII letters/digits/underscore/hyphen,
  normalized uppercase). Existing codes are read-only in the editor; names can
  change. Validate names (nonblank, at most 120 characters) and duplicate codes.
- Missing configuration falls back to the existing eight options, enabled, with
  code labels. The user has not specified which codes to retire; backend owners
  make that choice. Explicit empty/all-disabled configuration stays empty and
  must never reseed the eight choices on reload.
- New rows start disabled. Saving an enabled row makes it available to operators.
- Default cargo type must refer to an enabled code; disabling the default clears
  it. New or crafted quote submissions cannot select disabled/unknown codes.
- Persist saved draft cargo codes and their optional display-label snapshots
  independently of the current option list. Renaming/disabling must not erase
  historical draft values. Existing PDF snapshots are untouched.

## Implementation boundaries

- `src/lib/quote.js`: shared cargo-type normalization, defaults and validation.
- `src/lib/store/normalize-quote.js`: preserve settings and draft header values.
- `src/routes/admin-settings.js`: validate/save settings; render the editor.
- `src/lib/views.js`: derive enabled options, validate submitted/default cargo
  types, and capture the chosen label for quote output.
- `views/admin-quote.ejs`, `public/admin-quote.js`: compact editor with code,
  display name, enabled status, local add/remove-unsaved-row and default updates.
- `views/workbench-quote.ejs`, `views/quote-document.ejs`, `src/lib/i18n.js`:
  display configured names and translated empty-state/editor copy.
- `scripts/audit-quote-cargo-types-test.js`: isolated JSON HTTP/normalization and
  relational map roundtrip coverage.

## Validation and blast radius

Test add/rename/disable, save and reload, unchanged settings before save, custom
codes in quote recompute/draft/PDF view, unknown/disabled rejection, invalid and
duplicate configuration rejection without partial writes, all-disabled state,
default clearing, legacy drafts and relational serialization. Run `npm run
test:all` with JSON isolation, plus local browser checks at desktop/mobile sizes.
Affected pages/endpoints are quote admin, quote workbench and quote PDF. Existing
fee formulas, currencies, auth/session, other modules and runtime flags retain
their contracts. Writes use the existing module save and cache behavior.

## Delivery and rollback

Work in an isolated remote clone; the original Cursor folder remains read-only.
Push a feature branch, following the repository's PR policy. Reverting the code
restores the fixed-list implementation, but that old implementation cannot retain
new custom codes during later normalization; export/retain any new quote headers
before such a rollback. No production data changes are part of this task.

## Review and verification notes

- `[SELF_CORRECTION]` Validation re-render must distinguish the stored row from
  a new row with a duplicate code. The rejected new row stays editable/removable.
- `[SELF_CORRECTION]` A temporarily blank display name must not clear an enabled
  default, including after a whitespace-only name is rejected by the server.
  Unsaved editor choices can fall back to the code until the name is corrected;
  successful persistence still requires a valid name.
- Browser checks used an isolated temporary JSON store. Editing FCL/LCL labels,
  disabling six legacy choices and adding PALLET yielded exactly three enabled
  choices in the local frontend. These test choices were not applied to production.
- Verified new rows initially disabled; save/reload and readonly saved codes;
  duplicate error recovery; default retention during rename; selected custom
  cargo in saved drafts; Spanish labels and 390px mobile editor with no horizontal
  overflow. Browser console showed no errors.
- Full runner passed all 24 suites, including quote/PDF, admin, session, storage
  and fee regression checks. The focused cargo suite covers the error-recovery
  fixes, settings validation/preservation, history and relational serialization.
