# Risks & Open Questions

## Risks
1. Selector expectation gap (users expect full vertical on day one) → Included/Coming-soon labels.
2. Dual VAT/currency doubles test matrix → parameterized money tests.
3. No local Postgres/Docker → managed-tier default; re-migrate cost if switched late.
4. Node 18 → must upgrade to 22 before scaffold.
5. RLS deferral relies on service checks + tests — never weaken to pass builds.

## Open questions (need your ruling)
- Manual payments assumption correct?
- RTL full QA in MVP or Next?
- Block-negative-stock / same-shift-void / walk-in-only defaults accepted?
- Managed Postgres + Vercel-class hosting acceptable?
