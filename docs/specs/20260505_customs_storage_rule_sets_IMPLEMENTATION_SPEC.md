# Customs Storage Rule Sets Implementation Spec

Date: 2026-05-05

## Scope

Upgrade customs terminal storage rules from direct per-container tier editing to:

- collapsible terminal and yard admin sections
- multiple configurable storage rule sets per terminal
- rule-set multi-select assignment to multiple shipping-line + container-type pairs
- one shipping-line + container-type pair can only belong to one rule set at a time
- quote calculation using the assigned storage rule set for the selected terminal, shipping line, and container type
- anchor-based navigation after adding a terminal or yard

## Compatibility

Keep `terminal.storageRulesByContainer` as compatibility data. New runtime paths prefer:

```json
{
  "storageRuleSets": [
    {
      "id": "storage-set-20GP",
      "name": "20GP",
      "rules": []
    }
  ],
  "storageAssignmentsByLineContainer": {
    "cma-cgm": {
      "20GP": "storage-set-20GP"
    }
  }
}
```

When admin saves a terminal, rebuild `storageRulesByContainer` from the first shipping line's selected rule set assignments so old readers still have compatibility data.

## Admin UX

- Terminal cards are collapsible.
- Yard cards are collapsible because they have the same long-form problem.
- Storage rule sets live inside each terminal.
- Each rule set has a multi-select of shipping-line + container-type pairs.
- Pairs already assigned to another rule set are disabled until the current assignment is removed.
- Tier rows are denser than the old per-container blocks.
- Adding a terminal redirects to the new terminal summary.
- Adding a yard redirects to the new yard summary.

## Validation

- `git diff --check`
- `npm run build:data`
- `npm test`
