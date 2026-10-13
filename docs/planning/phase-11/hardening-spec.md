# Phase 11 / T10 — Hardening Slice Specification

Status: **approved by the owner 2026-10-13, every decision as recommended.** Decisions marked **(rec)** can still be
overridden. As built: [hardening-as-built.md](hardening-as-built.md).

Source: `docs/planning/task-breakdown.md` (T10 "rate-limit, print CSS, EN/AR", deps T1–T9), the items earlier phases
deferred to T10 (receipt print layout, refund receipts, Z-report printing, PO printing, Arabic digits D10, locale
persistence), and `docs/architecture/security-model.md`.

## 1. Key facts

- **Rate limiting** exists only inside Better-Auth (DB storage): sign-in and sign-up 5 per minute, other auth routes
  100 per minute (`lib/auth/auth.ts`). The business API (`/api/sales`, `/api/purchasing`, `/api/reports`, …) has none.
- **Security headers**: none are set (`next.config.ts` has no `headers()`; `proxy.ts` only gates the session).
- **Receipt**: the till shows an on-screen receipt after a sale and calls `window.print()`; only the buttons are hidden
  in print. No shop name, address, tax number, header or footer is printed, though `Organization` already has
  `legalName`, `taxNumber`, `receiptHeader`, `receiptFooter`, `receiptAddress`, `receiptPhone`. No screen or API sets
  them. There is no way to reprint a past sale (no `GET /api/sales/{id}`).
- **Refunds, voids, shift close, PO**: no printable layout for any of them.
- **EN/AR**: every screen goes through the typed dictionary (`lib/i18n`, 670 keys, EN and AR). The locale is already
  persisted in the `pos_locale` cookie and applied before first paint. Money uses Latin digits in both locales (D10).
  Catalog and inventory have RTL E2E specs; POS, returns, reports, purchasing and audit do not.
- Out of scope by `requirements.md`: ZATCA e-invoicing and Egypt e-receipt certification. A receipt here is a
  customer slip, not a tax e-invoice.

## 2. Goal and success

A cashier prints a clean 80 mm receipt for any sale, refund or void, with the shop's details, in English or Arabic,
and can reprint it later. A manager prints the shift close (Z-report). An owner prints a purchase order for the
supplier. The business API refuses floods per user, and every response carries baseline security headers. Every
screen passes an Arabic RTL check.

Out of scope: tax e-invoices and their QR codes, printer drivers or ESC/POS (browser print only), email or SMS
receipts, a full settings area beyond the receipt fields, a CSP with nonces (see H5).

## 3. Decisions

| # | Topic | Decision |
|---|---|---|
| H1 | Receipt paper | **80 mm thermal** via `@page { size: 80mm auto; margin: 0 }` and a print-only receipt component; A4 prints the same column centred. 58 mm not supported. **Owner: confirm, or name 58 mm.** |
| H2 | What a receipt shows | Shop `legalName` (else `name`), branch name and address, `receiptPhone`, tax number labelled "VAT no." / "الرقم الضريبي", `receiptHeader`; sale number, date and time in the shop's timezone, cashier, register; lines (name in the receipt's locale, qty, line total); subtotal, VAT with its rate, total; each tender, change; `receiptFooter`. Refund and void receipts reuse it, titled "Refund"/"Void" with the original sale number and the reason. **Owner: confirm or trim.** |
| H3 | Receipt fields editing | A **Receipt settings** screen (`/settings/receipt`) and `PATCH /api/org/receipt` for the six existing `Organization` fields. Uses the existing `settings.manage` (Owner, Admin). No migration. **Owner: confirm, or say Owner only.** |
| H4 | Reprint | `GET /api/sales/{id}/receipt` (branch-scoped; `sales.refund` holders, or the cashier who made the sale) returns the receipt data; a **Reprint** button on the Returns sale lookup and on the till's last sale. A reprint is marked "Copy" / "نسخة" and audited `sale.receipt.reprinted`. **Owner: confirm the "Copy" mark.** |
| H5 | Security headers | Set on every route: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Permissions-Policy` (camera, mic, geolocation off), `Strict-Transport-Security` in production only. A static CSP without nonces (`default-src 'self'`, `script-src 'self' 'unsafe-inline'` for the locale script, `frame-ancestors 'none'`). A nonce CSP would force every page dynamic under Cache Components; defer to Phase 13. **Owner: accept the static CSP for now.** |
| H6 | API rate limit | Per user per org, fixed 60 s window, in PostgreSQL (one small table, one migration), so it holds across server instances. Writes (`POST/PATCH/DELETE`) 120 per minute; reads 600 per minute; CSV exports 10 per minute. Over the limit: 429 `RATE_LIMITED` with `Retry-After`. Unauthenticated API calls already get 401 before the limiter. **Owner: confirm the numbers.** |
| H7 | Where the limiter runs | In the shared route wrapper (`app/api/_lib`) after the session is resolved, not in `proxy.ts`, because the key needs the user and org. One `INSERT … ON CONFLICT DO UPDATE … RETURNING count` per request. **(rec)** |
| H8 | Limiter failure | If the limiter's query fails, the request goes through and the error is logged (fail open), so a limiter fault never stops a sale. **(rec)** |
| H9 | Z-report print | The shift close summary and the Shifts report row get a **Print** button using the same 80 mm layout: opening float, cash sales, pay-ins, pay-outs, drops, cash refunds, expected, counted, difference and note. **(rec)** |
| H10 | PO print | A4 layout from the PO detail screen: shop details, supplier (name, phone, tax number), PO number, branch, date, lines with qty and unit cost, total, note. Only for users who may view the PO (cost is already shown to them, purchasing P6). **(rec)** |
| H11 | Receipt locale | The receipt prints in the cashier's current UI locale; Arabic prints RTL with Latin digits for money, numbers and dates (D10 kept). **(rec)** |
| H12 | RTL coverage | Add an Arabic E2E per remaining screen group (POS, returns, reports, purchasing, audit): `dir="rtl"` set, no English left in visible text (checked against the dictionary), numbers `dir="ltr"`. Plus a unit test that EN and AR have the same key set and placeholders. **(rec)** |
| H13 | Audit | `settings.receipt.updated` (old and new values), `sale.receipt.reprinted`, `api.rate_limited` (once per user per window, not per request). **(rec)** |

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Printers differ; a layout that looks right on screen clips on paper. | Fixed 80 mm width, no images, system fonts, one manual print check on a real printer before merge. |
| R2 | The rate limiter adds a DB write to every API call. | One upsert on a tiny indexed table; old windows deleted by the same statement's key rollover. Measured in the perf test from T9. |
| R3 | A too-low limit blocks a busy till (scanner bursts). | Limits well above a human pace (2 writes per second sustained); scanner search is a read. |
| R4 | CSP breaks a page. | Static CSP checked by the full E2E suite in a production build before merge. |

## 5. Acceptance

1. A sale, a refund and a void each print on 80 mm with every H2 field, in EN and AR; screenshots in the as-built notes.
2. A reprint shows "Copy" and writes one audit event.
3. Receipt settings save and appear on the next receipt; Manager and Cashier get 403.
4. The 121st write in a minute answers 429 with `Retry-After`; the next window passes. Integration test.
5. Every response carries the H5 headers (route test plus one E2E on a page).
6. Arabic E2E green for every screen group; EN/AR key parity unit test green.
7. lint, tsc, vitest, `next build`, full Playwright green.
