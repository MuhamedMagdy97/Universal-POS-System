# Phase 11 / T10 — Hardening Slice: As Built

Spec: [hardening-spec.md](hardening-spec.md) (approved 2026-10-13, every decision as recommended). Built on
`phase-11/hardening`.

## 1. What was built

| Spec | Where |
|---|---|
| H1, H2 receipt slip | `app/(app)/_components/receipt-print.tsx` (`ReceiptSlip`), print CSS in `app/globals.css` |
| H2, H4 receipt data, reprint | `modules/sales/receipt.ts` (`getReceipt`), `GET /api/sales/{saleId}/receipt?kind=SALE\|REFUND\|VOID&refund={id}&copy=1`, Server Action `app/(app)/_lib/receipt-action.ts` |
| H3 receipt settings | `modules/org/receipt.ts`, `GET`/`PATCH /api/org/receipt`, screen `/settings/receipt`, header link "Settings" |
| H5 security headers | `next.config.ts` `headers()` (`SECURITY_HEADERS`) |
| H6–H8 rate limit | `lib/rate-limit.ts`, called from `apiRoute` (`app/api/_lib/route.ts`); table `ApiRateLimit` (migration `api_rate_limit`); `Retry-After` set in `lib/errors.ts` |
| H9 Z-report | `modules/registers/shifts.ts` (`getZReport`), `app/(app)/_components/zreport-print.tsx`; Print on the shift close summary and on each closed row of the Shifts report |
| H10 PO print | A4 layout on `/purchasing/{poId}` behind "Print order" (`PrintButton` in `app/(app)/_components/printing.tsx`) |
| H11 locale | Slips print in the UI locale, RTL in Arabic, Latin digits (`receiptTime`, `formatMoney`) |
| H12 RTL | `tests/e2e/hardening.spec.ts` (returns, reports, audit, purchasing, settings in Arabic: `dir`/`lang` and no English UI phrase left in `<main>`); EN/AR key parity was already covered by `tests/unit/i18n.test.ts` |
| H13 audit | `sale.receipt.reprinted`, `settings.receipt.updated` (old and new per field), `settings.permission.denied`, `api.rate_limited` (once per user, bucket and window) |

How printing works: a print button loads its data, mounts the slip in a `.print-root` at the end of `<body>` and
calls `window.print()`. In print media, `body:has(> .print-root) > :not(.print-root)` is hidden, so only the slip
prints. Pages without a print root (reports) print as before.

## 2. Deviations

1. **The receipt page is sized when printing.** `size: 80mm auto` is not valid CSS, so just before `window.print()`
   the slip is measured and `@page receipt` is set to 80 mm × its height (+4 mm). A PDF matches the slip and a roll
   feeds no blank paper. The first version set no size, and "Save as PDF" put the slip on an A4 sheet (owner check,
   2026-10-13). The slip is a 72 mm column, the printable width of 80 mm paper.
2. **"Copy" is chosen by the screen, not inferred.** The server cannot tell a print from a fetch, so the first
   press of the Print button shown right after a sale, refund or void asks with `copy=0` (not audited); a second press
   of that button and every reprint button ask with `copy=1` (marked and audited). The API is open to `copy=0` for
   the same callers; the slip is a customer slip, not a tax invoice.
7. **A void slip shows the total as refunded and no change**, with the original tenders listed, since a void hands
   back what was taken.
8. **The rate window is taken from the database clock** (`date_trunc('minute', now())`) and only moves forward, so
   instances with skewed clocks and late requests never reset a running count.
3. **Who may print.** A receipt: the cashier who made the sale, or any `sales.refund` / `sales.void` holder, in branch
   scope. A Z-report: `registers.close` (the till) or `reports.view` (the Shifts report), in branch scope, closed
   shifts only.
4. **The rate limit covers Route Handlers (`/api/*`) only.** The screens use Server Actions, which are not counted.
   They are session-gated and run at human pace; counting them is a Phase 13 item if needed.
5. **E2E signs in as Admin, not Owner**, for settings and the Arabic sweep: the auth setup has no Owner session, and
   Admin holds the same `settings.manage` and audit rights.
6. **`prisma migrate dev` proposes dropping `POItem_one_line_per_item`** (a `NULLS NOT DISTINCT` index Prisma cannot
   model). The `api_rate_limit` migration was created with `--create-only` and hand-trimmed; do the same for every
   future migration.

## 3. Tests

- `tests/integration/hardening.test.ts` (15): receipt fields saved, cleared, audited, refused for Manager and
  Cashier; sale, refund and void receipts match the stored rows; reprints audited; other cashiers 403, other tenants
  404; Z-report matches the close; route 200/422; 429 with `Retry-After`, audited once, reads unaffected, next window
  passes, a late request from an older window still counts, counted per user.
- `tests/unit/hardening.test.ts` (5): buckets, windows, 429 envelope, headers and CSP.
- `tests/e2e/hardening.spec.ts` (8): settings onto the printed slip; print media shows only the slip; reprint
  "Copy" and a second press of Print is a copy; only the last printed slip goes to paper; Arabic slip RTL with Latin digits; Returns reprint and refund slip; Z-report after close; Manager denied
  settings; headers on a page and an API route; Arabic sweep; A4 PO print with supplier, lines and total.
- Full suites: vitest 730 passed (1 skipped), Playwright 56 passed, lint, typecheck, Prettier and `next build` clean.
- Manual print check (risk R1): done by the owner 2026-10-13. Edges, length and text size fine; the PDF page size was
  wrong and is fixed (deviation 1).

## 4. Not done

- Nonce CSP (Phase 13), ESC/POS or printer drivers, e-invoicing (out of scope).
