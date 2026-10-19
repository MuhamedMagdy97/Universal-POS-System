# Financial and inventory invariants check

Release checklist item (Phase 14): "Financial + inventory invariants verified against known transactions".

- **Date:** 2026-10-19
- **Base commit:** `0b6ded5` (main), branch `claude/invariants-97f83f`; the check is the commit that adds this file.
- **Test:** [tests/integration/invariants.test.ts](../../tests/integration/invariants.test.ts)
- **Result:** every figure matched the hand-worked numbers. No bugs found.

## What was built

A fresh shop with one fully known day of trading, made through the real services (no direct table
writes apart from setting prices, costs and the shop's country). It runs twice: an **EG** shop
(EGP, 14% VAT) and an **SA** shop (SAR, 15% VAT). Prices include VAT.

| Step       | What happens                                                                   |
| ---------- | ------------------------------------------------------------------------------ |
| Opening    | Branch A: P1 10, P2 20, P3 5 (zero-rated, no cost), P4 10 · Branch B: P2 5     |
| Shift      | Till T1 opened with a 500.00 float                                             |
| S1         | P1×2, cash with change; cost snapshot 60.00                                    |
| PO receipt | P1×6 @ 70.00 + P2×10 @ 30.00 = 720.00; P1's cost becomes 70.00                 |
| S2         | P1 + P2×2, split card 100.00 + cash with change; cost snapshot 70.00           |
| S3         | P3 + P4×3, wallet (P4's VAT does not divide evenly)                            |
| S4         | P2, cash, then voided                                                          |
| S5         | P2, split card + wallet                                                        |
| R1         | Refund one of three P4 from S3, cash (VAT share rounds)                        |
| R2         | Refund the P1 line of S2, card                                                 |
| Cash       | Pay-in 50.00, pay-out 20.00, drop 300.00                                       |
| Adjustment | Branch A P3 −1 (damaged)                                                       |
| Transfer   | Branch A → B, P2×4                                                             |
| Close      | Counted 0.50 short, with a note                                                |

All rows are then moved to fixed times on 2026-04-15 (same local day in Cairo and Riyadh).

## What was asserted

Each expected figure is a literal in the test with the arithmetic beside it.

1. **Sale and refund totals:** total, VAT and change of every sale; amount and VAT of each refund,
   including the rounded VAT share of a partial refund (EG 1.23 of 3.68, SA 1.30 of 3.91).
2. **Inventory:** `reconcile()` finds no balance that differs from its ledger, and on-hand per item
   per branch is exact (A: P1 14, P2 23, P3 3, P4 8 · B: P2 9, others 0).
3. **Shift close:** expected cash (EG 576.00, SA 580.00) and difference (−0.50), with each term
   (float, cash sales, pay-in, pay-out, drop, cash refunds) the same in the close, the Z-report
   and the Shifts report.
4. **Sales summary:** sales count, gross, VAT, net, refunds, voids and net after refunds.
5. **Payments by method:** sales, refunds and net per method; the method totals add up to gross
   sales and to total refunds.
6. **VAT by rate:** the standard rate and 0% rows; VAT and net sales equal the sales summary.
7. **Profit (P12):** cost is snapshotted at checkout (60.00 before the receipt, 70.00 after);
   profit by product, including a refund that reverses cost, an item with no cost kept apart, and
   the recomputed total margin (EG 40.14%, SA 40.12%). Net revenue equals VAT net sales less net
   refunds, and the profit-by-day and profit-by-category totals match profit by product.
8. **Purchases:** one receipt, 16 units, 720.00 at the received cost.

## Command and output

```bash
npx vitest run tests/integration/invariants.test.ts --reporter=verbose
```

```
 ✓ tests/integration/invariants.test.ts > invariants, EG shop > prices each sale and refund to the hand-computed totals 2ms
 ✓ tests/integration/invariants.test.ts > invariants, EG shop > keeps every stock balance equal to its ledger, with the expected on-hand 6ms
 ✓ tests/integration/invariants.test.ts > invariants, EG shop > closes the shift at the hand-computed expected cash and difference 39ms
 ✓ tests/integration/invariants.test.ts > invariants, EG shop > reports sales, refunds and voids for the day 5ms
 ✓ tests/integration/invariants.test.ts > invariants, EG shop > reports payments by method, adding up to gross sales 5ms
 ✓ tests/integration/invariants.test.ts > invariants, EG shop > reports VAT by rate, matching the summary's VAT and net 5ms
 ✓ tests/integration/invariants.test.ts > invariants, EG shop > snapshots cost at checkout and reports profit from it 17ms
 ✓ tests/integration/invariants.test.ts > invariants, EG shop > reports the goods received at their cost 5ms
 ✓ tests/integration/invariants.test.ts > invariants, SA shop > prices each sale and refund to the hand-computed totals 1ms
 ✓ tests/integration/invariants.test.ts > invariants, SA shop > keeps every stock balance equal to its ledger, with the expected on-hand 5ms
 ✓ tests/integration/invariants.test.ts > invariants, SA shop > closes the shift at the hand-computed expected cash and difference 22ms
 ✓ tests/integration/invariants.test.ts > invariants, SA shop > reports sales, refunds and voids for the day 5ms
 ✓ tests/integration/invariants.test.ts > invariants, SA shop > reports payments by method, adding up to gross sales 5ms
 ✓ tests/integration/invariants.test.ts > invariants, SA shop > reports VAT by rate, matching the summary's VAT and net 5ms
 ✓ tests/integration/invariants.test.ts > invariants, SA shop > snapshots cost at checkout and reports profit from it 16ms
 ✓ tests/integration/invariants.test.ts > invariants, SA shop > reports the goods received at their cost 5ms

 Test Files  1 passed (1)
      Tests  16 passed (16)
```

Full suite on the same commit (`npm test`): `Test Files 68 passed | 1 skipped (69)`,
`Tests 780 passed | 1 skipped (781)`. `npm run lint` and `npm run typecheck` exit 0.

The test runs in the normal suite, so CI repeats this check on every push.
