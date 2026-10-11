# Acceptance Criteria (MVP, testable)

1. Valid-stock sale → receipt + ledger deduction + report match.
2. Same idempotency key twice → one sale.
3. Concurrent limited-stock sales respect block-negative policy.
4. Unauthorized discount → 403 + audit attempt.
5. Refund > refundable → rejected.
6. Cross-tenant read → 403/404, no leak.
7. Mid-transaction failure → no unexplained partial records (documented recovery).
8. Duplicate provider callback → single financial effect (boundary ready).
9. Post-sale price change → old sale unchanged.
10. Shift close with discrepancy → recorded, shift immutable.
11. Return with wrong/missing original → rejected.
12. Migration applies cleanly to seeded EG/SA dataset.
