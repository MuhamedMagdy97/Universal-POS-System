# ZATCA Phase 1 (generation phase) receipts: Specification

Status: **Spec approved by the owner (2026-10-20, every decision as recommended). BUILT on the "Receipts: ZATCA
Phase 1 QR" PR.**

Source: `docs/product/known-limitations.md` ("no tax QR codes"), the as-built `modules/sales/receipt.ts`,
`modules/org/receipt.ts`, `app/(app)/_components/receipt-print.tsx` and `/settings/receipt`.

## 1. What ZATCA asks for (public sources)

- **E-Invoicing Regulation** (ZATCA Board resolution, 4 Dec 2020) and the **Controls, Requirements, Technical
  Specifications and Procedural Rules for Implementing the Provisions of the E-Invoicing Regulation** (ZATCA, May 2021):
  from **4 Dec 2021 (Phase 1, "generation phase")** every VAT-registered taxpayer issues tax invoices and notes
  electronically from a compliant solution. Phase 2 ("integration phase") rolls out in waves from 1 Jan 2023.
- **E-Invoicing Detailed Guidelines** (ZATCA, generation phase) and the **QR code** section of the technical
  specification: a **simplified tax invoice** (B2C, the till's case) and the **credit and debit notes associated with
  it** must carry a QR code. In Phase 1 the QR holds five fields, each as a **TLV** (tag 1 byte, length 1 byte, value
  UTF-8 bytes), concatenated and **Base64**-encoded:
  1. seller name, 2. seller VAT registration number, 3. invoice timestamp (ISO 8601), 4. invoice total with VAT,
  5. VAT total.
- **VAT Implementing Regulations, Article 53(8)** (simplified tax invoice content): issue date, seller name and VAT
  number, the goods supplied, the total including VAT and the VAT amount. **Article 54** (credit/debit notes): refer to
  the original invoice and give the reason.
- The guidelines require the document title "Simplified Tax Invoice" (and the Arabic "فاتورة ضريبية مبسطة"); Arabic
  is mandatory on the document, English may accompany it.
- A Saudi VAT registration number is **15 digits, starting and ending with 3**.

Phase 1 forbids, among other things, editing or deleting an issued invoice: this app already never edits a sale; a
refund or void is a separate document.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| Z1 | Scope | **SA shops only** (shop country is fixed at setup). EG shops are unchanged. |
| Z2 | Seller VAT number | Reuse the existing `Organization.taxNumber` ("VAT number" in /settings/receipt) — **no migration**. For an SA shop it must be 15 digits, first and last digit 3 (`isSaudiVatNumber`); saving anything else is a 422 validation error. An empty value is allowed (the shop may not have it yet). EG shops keep the free text (≤ 40). |
| Z3 | Missing VAT number | An SA shop without a valid VAT number (empty, or an older free-text value) prints the plain receipt as before: **no tax-invoice title, no QR**, since a document calling itself a tax invoice without the seller's VAT number is not compliant. /settings/receipt shows a clear warning until it is set. |
| Z4 | Sale receipt | SA + valid VAT: title **"Simplified Tax Invoice / فاتورة ضريبية مبسطة"** (both languages, whatever the UI locale), seller name and VAT number (already printed), the invoice timestamp (already printed, shop time zone), and a **QR code** at the bottom. Reprints/copies print the same title and the same QR (with the "Copy" mark). |
| Z5 | Seller name (tag 1) | `legalName` when set, else the shop name — the same name printed at the top. UTF-8, so an Arabic name uses 2 bytes a letter; a value over 255 bytes cannot fit a 1-byte length and is cut at a character boundary (the field limit is 120 characters, so only an all-Arabic 120-character name could reach it). |
| Z6 | Timestamp (tag 3) | The document's moment in **UTC, ISO 8601 to the second**: `2026-10-20T09:15:00Z` (the form in ZATCA's samples). |
| Z7 | Amounts (tags 4, 5) | Decimal with 2 places, no grouping, no currency: `1150.00`, `150.00`. Tag 4 is the document total including VAT (after discounts), tag 5 its VAT. |
| Z8 | Refund and void slips | **Simplified credit notes**: title **"Credit Note / إشعار دائن"**, they already print the original sale number and the reason (Art. 54), and they carry a QR with the note's own seller, VAT, timestamp, total and VAT (positive amounts). Recommended because the guidelines require the QR on notes associated with a simplified invoice too, and a refund/void is exactly that note. |
| Z9 | QR rendering | Built on the server inside `getReceipt` (`modules/sales/zatca.ts`): TLV → Base64 → QR matrix (`uqr`, error correction M) → one SVG `path` string. The print slip renders it as inline `<svg>` (no image, no script, no CDN), so the nonce CSP is untouched; 30 mm square on the 80 mm slip, black on white, quiet zone included. |
| Z10 | Dependency | **`uqr`** (unjs, MIT, zero dependencies, ~15 KB, ships types and is ESM). The `qrcode` package pulls `pngjs`/`yargs`; hand-writing a QR encoder is ~400 lines of Reed–Solomon nobody should maintain. Installed with `npx npm@10`. |
| Z11 | Storage | Nothing new stored: the QR is rebuilt from the sale/refund snapshot and the shop's current name and VAT number on every print, like the rest of the slip. A change of legal name or VAT number shows on later reprints. |
| Z12 | Audit | Unchanged: a VAT number change is already audited as `settings.receipt.updated`; reprints as `sale.receipt.reprinted`. |

## 3. Out of scope: what Phase 2 (integration) would need

- **Onboarding** each till/EGS unit with ZATCA: generate a key pair and CSR, get a compliance CSID with the OTP from the
  Fatoora portal, pass the compliance checks, then a production CSID (certificate) — per device, stored encrypted.
- **UBL 2.1 XML** for every invoice and note (ZATCA's KSA extensions), with an invoice counter (ICV), the hash of the
  previous invoice (PIH) chaining every document, and a UUID.
- **Cryptographic stamp**: ECDSA (secp256k1) signature over the invoice hash, embedded as XAdES in the XML.
- **Phase 2 QR**: tags 6–9 on top of 1–5 (invoice hash, ECDSA signature, public key, and for simplified invoices the
  certificate signature).
- **Reporting** simplified invoices to the Fatoora API within 24 hours (clearance applies only to standard B2B
  invoices), with retry and a queue that survives offline tills; storing ZATCA's responses and warnings.
- Credit notes would need the billing reference (original invoice id) in the XML, and a cancelled sale would need a
  note rather than a void.
- Per-tenant toggle and credentials, as every integration here is.

## 4. Tests

- Unit: TLV against ZATCA's published sample (`Bobs Records`, `310122393500003`, `2022-04-25T15:30:00Z`, `1000.00`,
  `150.00`), Arabic seller name byte length, VAT number validation, amount and timestamp formats.
- Integration: an SA sale, its refund and void get the tax-invoice/credit-note data and the expected TLV; an SA shop
  without a VAT number and an EG shop get none; saving an invalid SA VAT number is refused.
- E2E: SA shop sets its VAT number (warning first), an SA sale prints the title and the QR; an EG sale prints no QR.
