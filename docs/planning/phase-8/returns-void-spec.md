# Phase 8 / T8 — Returns, Refunds and Voids Specification

Status: **approved by the owner 2026-10-12; built** (see [returns-void-data-model-and-api.md](returns-void-data-model-and-api.md) for what differs). All recommendations (**rec**) in §3 are
accepted as written, including V1: refunds for Owner and Manager only; Admin gets no refund permission.

Source: `docs/planning/task-breakdown.md` (T8, deps T6), `docs/product/business-rules.md` (rules 5, 7, 9),
`docs/product/user-flows.md` (J2), `docs/product/user-roles-permissions.md`, the T6 checkout and T7 shift close.

## 1. Key facts

- The schema already has `Refund` (idempotency key, method, reason, totals, optional `shiftId`), `RefundItem` (per
  `SaleItem`: qty, amount, VAT) and `SaleStatus` (`COMPLETED`, `VOIDED`). No migration is expected for the core flow.
- The inventory seam already accepts `REFUND` and `SALE_VOID` movements (`recordMovements`). Both are in
  `ARCHIVED_ALLOWED`, so returning stock of an archived item works.
- Business rule 7: refund per line ≤ sold − already refunded. Refunds reference the original sale. A void keeps the
  original sale and writes compensating movements and an audit row.
- Business rule 9: a closed shift is immutable. A refund or void must never change a closed shift's numbers.
- T7 expected cash counts `COMPLETED` sales only. A voided sale therefore drops out automatically. Cash refunds are
  **not** counted yet: T7 left a placeholder for a negative term (see `shift-close-data-model-and-api.md` §2).
- Permissions: `sales.refund` (Manager and Owner) and `sales.void` (Manager and Owner) exist. Admin holds neither
  (`lib/auth/permissions.ts`), as with the T7 close decision.

## 2. Goal and success

A manager or owner can refund some or all lines of a completed sale, or void a whole sale made on the same open
shift. Each refund or void moves stock back, writes its payment side (cash leaves the drawer for a cash refund),
writes an audit row, and never touches a closed shift. Replaying a refund with the same `Idempotency-Key` returns the
original refund and does not refund twice.

Out of scope: exchanges (refund plus new sale), refunds without an original sale, store credit, discounts on refunds,
refund receipts printed in T10, and manager approval thresholds.

## 3. Decisions

| # | Topic | Proposal |
|---|---|---|
| V1 | Who may refund | `sales.refund`: Owner and Manager. Admin does not hold it today; adding it is a permissions change. **(rec)** keep Owner and Manager. **Owner** |
| V2 | Who may void | `sales.void`: Owner and Manager. **(rec)** |
| V3 | Partial refund | Per-line qty, validated against `sold − refunded` per `SaleItem` (rule 7). Several partial refunds per sale are allowed. **(rec)** |
| V4 | Refund amount and VAT | Per line: `amount = round_half_up(lineTotalMinor × qtyRefunded ÷ qtySold)`. VAT is taken back out of that gross amount at the line's snapshotted rate (same rounding as sales). The last partial refund of a line takes the remainder, so the line never over- or under-refunds by a unit. **(rec)** |
| V5 | Refund method and drawer | Method is `CASH`, `CARD_MANUAL` or `WALLET`, with a manual reference for non-cash. A cash refund reduces the drawer; a card or wallet refund does not touch it. No automatic card reversal (manual payments only). **(rec)** |
| V6 | Which shift books a refund | The **open** shift on the sale's register. If none is open, refuse `SHIFT_NOT_OPEN`. A closed shift is never changed. **(rec)** |
| V7 | Void scope | A void is allowed only when the sale's shift is still open and the sale is `COMPLETED`. Voiding every line is then a full void, and the sale becomes `VOIDED`. A sale on a closed shift can only be refunded, not voided. **(rec)** |
| V8 | Refunds after a void | Refused: a voided sale has nothing left to refund. |
| V9 | Stock on refund | Refund returns the refunded qty with reason `REFUND` (`refType: Refund`). A void writes `SALE_VOID` for every line (`refType: Sale`). Stock is returned with `policy: allow`, since it only adds stock. **(rec)** |
| V10 | Cash over the drawer | A cash refund may exceed the drawer's cash. The till shows the expected cash after the refund; the close screen reports any shortage. Nothing is blocked. **(rec)** |
| V11 | Idempotency | `Idempotency-Key` header on refund (`Refund.idempotencyKey`, unique per org), as on sales. Same key and same body → 200 with the original refund. Same key, different body → 409 `IDEMPOTENCY_CONFLICT`. Voids use the same header. **(rec)** |
| V12 | Expected cash (T7 change) | Add a negative term for cash refunds on the shift: `− Σ Refund.totalMinor where method = CASH and shiftId = shift`. A void removes its sale's cash payment automatically (status filter). Covered by a test on the T7 formula. |
| V13 | Audit | `refund.create` and `sale.void` rows in the same transaction. Denials audit-logged, as elsewhere. Metadata has no card data. |
| V14 | Errors | `REFUND_QTY_EXCEEDED` (per line, with `details.lines`), `SALE_NOT_COMPLETED` (void or refund of a voided sale), `VOID_SHIFT_CLOSED` (void after close), `SHIFT_NOT_OPEN`, `IDEMPOTENCY_CONFLICT`, `PAYMENT_MISMATCH` for a refund method that does not fit. Shared codes with `details.reason`. |
| V15 | Locking | Refund and void take the **shift row lock** (T7 `lockShift`) first, then the sale row, then the inventory seam's locks. Same order as sales, so a sale and a refund on the same shift cannot deadlock. |
| V16 | Concurrency test | Two concurrent refunds of the same line cannot exceed `qtySold`. A void and a refund racing on one sale end with either a full void or a refund, never both. |

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Over-refund under concurrency. | V15 lock order; V16 test. The refunded qty is re-summed under the lock. |
| R2 | Rounding leaves a cent behind on partial refunds. | V4 remainder rule; unit test over many partial splits of an odd total. |
| R3 | A void after the shift closed changes a closed shift's totals. | V7 refusal; test that the closed shift's `expectedCashMinor` is unchanged after the attempt. |
| R4 | Cash refund not in the drawer count. | V12 term in the T7 formula; test with a refund and a close. |
| R5 | Stock returned for a line the sale never took. | Quantities come from `SaleItem` snapshots; the seam's `REFUND` reason is only written from a validated refund. |

## 5. Interfaces (to be detailed in the API part)

- `POST /api/sales/{saleId}/refunds` (`sales.refund`, `Idempotency-Key`): body `{ lines: [{ saleItemId, qty }] (1–200), method, reference?, reason (1–200) }`.
  Response 201 new · 200 replay: `RefundDetail` (refund id, totals, lines, method). The sale stays `COMPLETED`.
- `POST /api/sales/{saleId}/void` (`sales.void`, `Idempotency-Key`): body `{ reason (1–200) }`. Response 200: the sale with `status: VOIDED`.
- Seam used: `recordMovements({ reason: "REFUND" | "SALE_VOID", refType, refId, policy: "allow" })`, `lockShift` (T7).

## 6. Next steps

1. Done: owner approved V1–V16 as recommended.
2. Write `returns-void-data-model-and-api.md` and `returns-void-ux-and-tests.md` in the T6/T7 layout.
3. Write `returns-void-task-plan.md`, then build with the same gates: lint, typecheck, unit and integration tests, route tests, E2E.
