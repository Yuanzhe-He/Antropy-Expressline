# Handover Terminal Mix Implementation Spec

Date: 2026-05-05

## Scope

Add editable terminal probability configuration for the handover module:

- Source initial terminal mix from `TARIFARIO 120426.xlsx`.
- Store terminal probability per handover shipping line as `port -> terminal -> ratio`.
- Let admin users edit, add, and delete terminal probability rows.
- Replace the handover front-page demurrage-structure hint with the selected shipping line terminal probability summary.

## Data Shape

Per handover shipping line:

```json
{
  "terminalMix": [
    {
      "id": "terminal-mix-manzanillo-contecon",
      "port": "MANZANILLO",
      "terminal": "CONTECON",
      "ratio": 0.55
    }
  ]
}
```

`ratio` is stored as a decimal from `0` to `1`. Admin input displays and saves percent values from `0` to `100`.

## Excel Import

Each sheet after `ALL NAV` is one shipping line. The terminal mix block is on the right side:

- port name in the first column of the block
- terminal name in the next column
- probability in the next column

The current source workbook contains `MANZANILLO` terminal distributions.

## Validation

- `git diff --check`
- `npm run build:data`
- `npm test`
