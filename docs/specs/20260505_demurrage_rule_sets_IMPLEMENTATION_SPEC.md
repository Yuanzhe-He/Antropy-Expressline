# Demurrage Rule Sets Implementation Spec

Date: 2026-05-05

## Scope

Upgrade handover admin demurrage management from per-container-group tier editing to:

- Multiple named demurrage rule sets per shipping line.
- Assignment of standard handover container types to one rule set.
- Quote calculation using the assigned rule set for the selected standard container type.

## Constraints

- Preserve existing local charge and guarantee editing, which still use the workbook-derived tariff groups.
- Preserve old `demurrage.rulesByGroup` as compatibility data while adding the new rule-set model.
- Do not change customs storage tiers in this task.
- Keep the current progressive tier validation: sequential starts, editable end day, only the last row can be open-ended.

## Data Shape

Per handover shipping line:

```json
{
  "demurrage": {
    "ruleSets": [
      {
        "id": "demurrage-set-gp-hq-dc",
        "name": "GP HQ DC",
        "rules": []
      }
    ],
    "assignmentsByContainerType": {
      "40GP": "demurrage-set-gp-hq-dc"
    },
    "rulesByGroup": {}
  }
}
```

`rulesByGroup` remains available for migration/fallback. New runtime paths should prefer rule-set assignment.

## Migration

- Existing `rulesByGroup` entries become one rule set per old tariff group.
- Standard handover container types are assigned to the first compatible rule set using their `rateGroupKeys`.
- If no compatible rule set exists, assign the first available rule set.

## Admin UX

- Add a rule-set assignment table: standard container type -> rule set.
- Add editable rule-set sections with add/delete tier buttons.
- Add an add-rule-set action.
- Remove demurrage editing based directly on `selectedLine.containerGroups`.

## Validation

- `npm run build:data`
- `npm test`
- Check that standard container types remain selectable for every shipping line.
- Check that a standard container type can calculate using an assigned rule set.
