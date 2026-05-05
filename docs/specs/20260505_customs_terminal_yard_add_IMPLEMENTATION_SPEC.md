# Customs Terminal and Yard Add Spec

Date: 2026-05-05

## Scope

Add backend controls on the customs admin page so users can append:

- A new terminal under an existing port.
- A new yard in the customs yard list.

## Behavior

- New terminals are created under the selected port and immediately appear in the terminal rule section.
- New yards are created in the yard rule section and immediately appear in shipping-line yard mapping lists.
- Newly created entries use editable placeholder names and zero-rate fee structures.
- Existing edit and save behavior for ports, terminals, yards, fixed charges, storage tiers, drop-off charges, and customs yard charges stays unchanged.

## Defaults

- New terminal:
  - one terminal fixed-charge row across all container types
  - default storage tiers across all container types
- New yard:
  - associated with the first available port by default
  - one drop-off charge row across all container types
  - one customs yard charge row across all container types
  - no shipping-line assignment until the user selects it

## Validation

- `git diff --check`
- `npm test`
