# Phase 8 / T7 — Shift Close and Cash Count Specification

Status: **approved by the owner 2026-10-12.** Nothing here is built yet. All recommendations (**rec**) in §3 are
accepted as written, including S5 (permission split) and S6 (discrepancy approval deferred).

Source: `docs/planning/task-breakdown.md` (T7 "Shifts + cash", deps T6), `docs/product/user-flows.md` (J4),
`docs/product/business-rules.md` (rule 9), `docs/architecture/api-contracts.md`, and the T6 checkout
([checkout-spec.md](checkout-spec.md), [checkout-data-model-and-api.md](checkout-data-model-and-api.md)).

## 1. Key facts

- `RegisterShift` already has the close columns: `closedById`, `closedAt`, `expectedCashMinor`, `countedCashMinor`,
  `discrepancyMinor`, `discrepancyNote`. `CashMovement` (`PAY_IN`, `PAY_OUT`, `DROP`) exists with `reason`. No
  migration is expected for the core flow; check before adding any column.
- Cash that stays in the drawer is the `CASH` `Payment` row amount. Change is `Sale.changeMinor` and is **not**
  counted again. So for a shift:
  `expectedCash = openingFloatMinor + Σ CASH Payment.amountMinor (sales on the shift) + Σ PAY_IN − Σ PAY_OUT − Σ DROP`.
  Cash refunds (T8) will add a negative term; this spec only reserves the place for it.
- Permission `registers.close` already exists and the Cashier role holds it (`lib/auth/permissions.ts`).
- Business rule 9: closed shifts are immutable. A correction is a new audit-logged entry, never an edit.
- Sales need an open shift (`Sale.shiftId` is NOT NULL). Once a shift is closed, the till must start a new shift.

## 2. Goal and success

A cashier counts the cash in the drawer and closes the shift. The server computes the expected cash from the ledger
(never from the client), records the counted cash and the discrepancy, and locks the shift. A discrepancy other than
zero needs a note. Cash pay-in, pay-out and drop are recorded with a reason during the shift and feed the expected
amount. Every close and cash movement writes an audit row in the same transaction.

Out of scope: refunds and voids (T8, which will add cash refund terms), shift reports and Z-report printing (T9/T10),
reopening a closed shift (not planned; correction is a new entry), and manager approval over a threshold (see D6).

## 3. Decisions

| # | Topic | Proposal |
|---|---|---|
| S1 | Expected cash source | Computed on the server at close time from the rows in §1. Never taken from the client. **(rec)** |
| S2 | Discrepancy | `discrepancyMinor = counted − expected`. A note (`discrepancyNote`, required, 1–500 chars) is required when the value is not 0. **(rec)** |
| S3 | Close is atomic | One transaction: lock the shift row, re-sum the ledger, write the close fields, audit row. A sale on the same shift that commits after the lock is refused (`SHIFT_NOT_OPEN`). **(rec)** |
| S4 | Sales during close | The shift row lock taken by close and the sale transaction both lock the shift. The sale either lands before the close sum or is refused. Tested with a concurrent close and sale. |
| S5 | Cash movements | `POST /api/shifts/{id}/cash-movements` with `{ type: PAY_IN \| PAY_OUT \| DROP, amountMinor > 0, reason (1–200) }`. Permission `registers.close` for `PAY_OUT`/`DROP`, `sales.create` for `PAY_IN`. **(rec)** The owner should confirm this split. |
| S6 | Manager approval | **Deferred (owner-approved).** Discrepancies are recorded and shown in the shift list, with no threshold or manager approval in T7. *As built: recorded on the shift and in the `shift.closed` audit row, and shown on the close summary. A shift list is not built yet (reports, T9).* |
| S7 | Idempotency | Close uses an `Idempotency-Key` like sales. A repeat close with the same body returns the closed shift (200). A close of an already-closed shift with a different body returns 409 `SHIFT_ALREADY_CLOSED`. **(rec)** *As built: state-based replay (same count and note → 200), no key column. See the data-model part §5.* |
| S8 | Currency rounding | All amounts are integer minor units (rule 1). No rounding step is needed for cash. |
| S9 | Open shift after close | The till shows "No open shift" again and offers **Open shift** (existing T6 flow). The register's opening float is the counted cash the cashier enters, not automatically carried over. **(rec)** |
| S10 | Errors | `SHIFT_NOT_OPEN` (existing), `SHIFT_ALREADY_CLOSED`, `DISCREPANCY_NOTE_REQUIRED`, `CASH_MOVEMENT_INVALID` for amount ≤ 0 or bad reason. Codes go in `details.reason` where a shared code exists. *As built: a bad movement body is a plain 422 `VALIDATION_FAILED` (zod), like every other input; no `CASH_MOVEMENT_INVALID` reason.* |
| S11 | Audit | `shift.closed` and `shift.cash_movement` rows in the same transaction. Denials audit-logged, as elsewhere. Metadata has no secrets and no card data. |

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Close sum and a concurrent sale disagree (sale commits after the sum). | S3/S4: row lock on the shift in both paths. Integration test with a concurrent sale during close. |
| R2 | Expected cash drifts if change is double-counted. | Formula in §1 uses applied payment rows only. Unit test with change, split tenders and zero-total sales. |
| R3 | A closed shift is edited through a second path. | Repository refuses writes when `status = CLOSED` except the close itself. Test every write path. |
| R4 | Cashier closes someone else's shift. | Close allowed to the shift's register in the current branch, with `registers.close`. Permission and branch test. |
| R5 | Double-submit of close. | S7 replay (state-based as built), and the submit button disabled while pending. |

## 5. Interfaces (to be detailed in the API part)

- `POST /api/shifts/{id}/close` (`registers.close`; replay by state, no key header): body `{ countedCashMinor, discrepancyNote? }`.
  Response: `ShiftCloseSummary` with `expectedCashMinor`, `countedCashMinor`, `discrepancyMinor`, `closedAt`.
- `POST /api/shifts/{id}/cash-movements` (S5).
- *As built:* no `GET /api/shifts/current`. The till page reads the expected cash on the server through
  `previewShiftCash` (`registers.close`, branch scope), and refreshes it after each sale and when the close panel opens.
- Uses existing: `requireBranch`, `requireRegister`, `record()` from `modules/audit`.

## 6. Next steps

1. Done: owner approved S1–S11 (S5 and S6 as recommended).
2. Write `shift-close-data-model-and-api.md` and `shift-close-ux-and-tests.md` in the T6 layout.
3. Write `shift-close-task-plan.md` and build with the same gates as T6: lint, typecheck, unit and integration tests,
   E2E on the dedicated test database.
