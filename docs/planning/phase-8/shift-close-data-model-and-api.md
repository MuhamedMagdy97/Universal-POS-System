# Phase 8 / T7 — Shift Close Data Model and API (as built)

Parent: [shift-close-spec.md](shift-close-spec.md). Decisions S1–S11 are approved.

## 1. Data model

No migration. `RegisterShift` already has `closedById`, `closedAt`, `expectedCashMinor`, `countedCashMinor`,
`discrepancyMinor`, `discrepancyNote`. `CashMovement` (`PAY_IN`, `PAY_OUT`, `DROP`, `reason`, `actorUserId`) is used as is.

## 2. Expected cash (S1)

    expectedCash = openingFloatMinor
                 + Σ Payment.amountMinor where method = CASH and sale.status = COMPLETED and sale.shiftId = shift
                 + Σ PAY_IN − Σ PAY_OUT − Σ DROP

- A `CASH` payment row stores the applied amount. Change is `Sale.changeMinor` and is not counted again.
- T8 voids and refunds must change this sum (a void leaves `COMPLETED`; a cash refund adds a negative term). A void or
  refund of a sale whose shift is already closed must not touch that shift (business rule 9): it books against the
  open shift doing the refund, and must take `lockShift` on it.

## 3. Locking (S3–S4)

`lockShift` takes `SELECT … FOR UPDATE` on the `RegisterShift` row. Close, cash movements and sale creation all take it
first, then re-read the status. Lock order: shift → org counter → product rows → balance rows. Close never takes the org
or product locks, so the order cannot deadlock.

## 4. Endpoints

| Method + path | Permission | Body | Success | Errors |
|---|---|---|---|---|
| `POST /api/shifts/{shiftId}/close` | `registers.close` | `{ countedCashMinor, discrepancyNote? }` | 200 `ShiftCloseSummary` | 422 `DISCREPANCY_NOTE_REQUIRED`; 409 `SHIFT_ALREADY_CLOSED`; 404 for a malformed, unknown, other-org or out-of-scope shift; 403 |
| `POST /api/shifts/{shiftId}/cash-movements` | `PAY_IN`: `sales.create`; `PAY_OUT`/`DROP`: `registers.close` | `{ type, amountMinor ≥ 1, reason (1–200) }` | 201 `CashMovementSummary` | 409 `SHIFT_NOT_OPEN`; 422 validation; 404; 403 |

`ShiftCloseSummary` = `ShiftSummary` + `closedAt`, `expectedCashMinor`, `countedCashMinor`, `discrepancyMinor`,
`discrepancyNote`.

## 5. Replay rule (deviation from S7)

S7 proposed an `Idempotency-Key` header. The build uses **state-based replay** instead: a repeat close with the same
`countedCashMinor` and `discrepancyNote` returns the closed shift (200). Any other close of a closed shift returns 409.
This needs no key column and gives the same result for a retry. Cash movements have no replay: a retried pay-out
is recorded twice. The movement screen (not built yet) must disable its button while a request is in flight.

## 6. Audit

`shift.closed` (expected, counted, discrepancy) and `shift.cash_movement` (type, amount), in the same transaction.
Denials write `sales.permission.denied` as before.

## 7. Till close screen (as built)

`/pos` shows **Close shift** next to "Shift open since…" for roles with `registers.close` (default: Owner and Cashier;
Admin and Manager do not hold it). The panel shows opening cash, cash sales, pay-ins, pay-outs, drops and the expected
cash *before* the count (user flow J4), read on the server by `previewShiftCash`. The count is typed in major units; the
difference updates live, and a non-zero difference shows the note box and blocks **Close shift** until a note is typed.
After closing, a summary shows expected, counted, difference and note; **Done** reloads into "No open shift".

Freshness: the page data is refreshed after each sale and when the panel opens; **Close shift** stays disabled until that
refresh has landed. If the server still finds a difference the screen did not (cash moved on another device), it answers
`DISCREPANCY_NOTE_REQUIRED`; the screen then shows the note box and refreshes the numbers.

Tests: `tests/unit/pos-close-helpers.test.ts` (count, note rule, error map), `tests/integration/shift-close.test.ts`
(service), `tests/integration/sales-routes.test.ts` (routes: 401/403/404/422/200/201/409), `tests/e2e/pos-close.spec.ts`
(short count with note, exact count).

Not built: a screen for pay-in, pay-out and drop (the API exists), and a shift list or Z-report (T9/T10).
