# Customs Storage Rule Sets Implementation Spec

Date: 2026-05-05

## Scope

Upgrade customs terminal storage rules from direct per-container tier editing to:

- collapsible terminal and yard admin sections
- multiple configurable storage rule sets per terminal
- default storage rule sets start with two tiers: 1-7 and 8+
- rule-set multi-select assignment to multiple shipping-line + container-type pairs
- one shipping-line + container-type pair can only belong to one rule set at a time
- quote calculation using the assigned storage rule set for the selected terminal, shipping line, and container type
- anchor-based navigation after adding a terminal or yard
- scroll-preserving navigation for local add/delete/release actions that should keep the operator in place

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
- Terminal summary bars expose delete actions without expanding the card.
- Shipping-line to yard mapping uses one collapsible card per shipping line, with mapped-yard counts on the summary bar.
- Yard cards are collapsible because they have the same long-form problem.
- Yard summary bars expose delete actions without expanding the card, and deletion cleans stale shipping-line yard references.
- Storage rule sets live inside each terminal.
- Storage rule set summary bars expose delete actions without expanding the rule set.
- Expanded shipping-line, yard, terminal, and storage rule cards show a visible current-editing state.
- Each rule set has a multi-select of shipping-line + container-type pairs.
- Pairs already assigned to another rule set are disabled until the current assignment is removed.
- Disabled pairs show their current owner and have an adjacent release action in the current rule card.
- Legacy persisted three-tier defaults (`1-7`, `8-10`, `11+`) migrate once to the two-tier default (`1-7`, `8+`); manually added tiers remain supported after migration.
- Storage rule sets can be deleted except for the last remaining set; the delete confirmation must show how many shipping-line / container-type combinations are assigned, and deletion clears those assignments instead of silently reassigning them.
- Tier rows are denser than the old per-container blocks.
- Adding a terminal redirects to the new terminal summary.
- Adding a yard redirects to the new yard summary.

## Validation

- `git diff --check`
- `npm run build:data`
- `npm test`
