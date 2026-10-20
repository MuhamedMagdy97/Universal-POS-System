# Egypt ETA e-receipts: Specification

Status: **Draft for the owner's approval (2026-10-20).** Docs only; built by a later session once the owner holds ETA
preprod credentials.

Source: the as-built `modules/sales` (`receipt.ts`, `create.ts`, `refunds.ts`, `totals.ts`), `prisma/schema.prisma`
(`Sale`, `SaleItem`, `Refund`, `Register`, `Branch`, `Product.vatCategory`, `Customer.taxNumber`),
`modules/integrations/inventory-sys/postings.ts` and `secret.ts`, and the public ETA SDK at
`sdk.invoicing.eta.gov.eg` (sources in §6). Facts marked **[unverified]** were not confirmed in ETA's own pages and
must be checked in preprod before slice 3 ships.

## 1. Key facts

- ETA's B2C **e-receipt** system wants every POS receipt sent to it, signed off by a content hash (the receipt
  **UUID**) chained to the previous receipt of the same POS. Receipts go as JSON batches to
  `POST /api/v1/receiptsubmissions` with a bearer token from `POST /connect/token`. [S1, S2]
- Authentication is per POS: headers `posserial`, `pososversion`, `posmodelframework`, `presharedkey`, body
  `grant_type=client_credentials`, `client_id`, `client_secret`. The token lives 3600 s and must be cached. [S1, S7]
- The current document versions are **1.2**: Receipt (`receiptType: "s"`), Return Receipt (`"r"`, with mandatory
  `referenceUUID` of the sale receipt) and Return Receipt Without Reference. 1.0 and 1.1 are retired. [S3, S4, S9]
- Submission answers **202** with `submissionUUID`, `acceptedDocuments[]` and `rejectedDocuments[]` after a synchronous
  structure check; full validation is asynchronous (submission `InProgress → Valid | Invalid`, receipt
  `Valid | Invalid | Cancelled`). An identical submission within 10 minutes is `422 DuplicateSubmission` with
  `Retry-After`. [S2, S6]
- Receipts must be submitted **within 24 hours** of issue; later ones need a Late Submission Request on the portal
  (yearly quota per taxpayer). Returns may be issued up to **540 days** after the sale. [S5]
- A buyer of type `P` needs a national ID and name when the receipt total is **≥ 150,000 EGP** (v1.2); type `B`
  always needs its tax registration number. [S3, S5]
- Every line needs `itemType` (`GS1` or `EGS`) and `itemCode`. Our catalog has neither today.
- Our app already has what the mapping needs: integer minor units, `vatCategory` (STANDARD / ZERO_RATED / EXEMPT),
  per-line discount and VAT snapshots, an optional customer snapshot with tax number, and an outbound queue with
  backoff (`ExternalStockPosting`, `drainPostings`, the minute scheduler) and AES-256-GCM sealed secrets.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| E1 | Scope | **EG shops only**, opt-in per tenant (`EtaLink.enabled`), off by default. SA shops and EG shops without it are unchanged. |
| E2 | What the owner obtains | On the ETA portal: (1) the taxpayer's **B2C tag**; (2) the **RIN** (tax registration number), registered trade name and **activity code**; (3) each branch's **ETA branch code** and structured address; (4) **one POS registration per register**, giving its serial, client id, client secret and pre-shared key [unverified: whether client id/secret are per POS or per taxpayer — the model stores them per POS so both work]; (5) **EGS codes** for items without a GS1 barcode. First in **preprod**, then again in production. |
| E3 | Storage | New `EtaLink` (1:1 org): `environment` (`PREPROD`/`PROD`), `rin`, `tradeName`, `activityCode`, `enabled`, `lastCheckAt/Ok`. `Branch` gains `etaBranchCode` and `etaAddress` Json (`governate`, `regionCity`, `street`, `buildingNumber`, optional `postalCode`, `floor`). New `EtaDevice` (1:1 register): `posSerial`, `osVersion`, `modelFramework`, `clientId`, `clientSecretCiphertext`, `presharedKeyCiphertext`, `keyId`, `secretLast4`, `lastUuid` (chain head), `tokenCiphertext`/`tokenExpiresAt`. Secrets sealed with `secret.ts` `seal/open` under the same server key as the inventory link; never returned by any API (last 4 only). Owner/admin only, audited `eta.link.updated` / `eta.device.updated` (field names, no values). "Test connection" fetches a token per device. |
| E4 | Readiness gate | Enabling is refused (`409 ETA_NOT_READY` with a list) until every active branch has a code and address, every active register has a device, and every active product has an item code. While enabled, a sale on a register without a device is refused `409 ETA_DEVICE_MISSING`. |
| E5 | Item codes | `Product` gains `etaItemType` (`GS1`/`EGS`) and `etaItemCode` (≤ 100). Product level only; variants inherit. Default suggestion: GS1 = the product's first barcode when it is 13/14 digits, else blank. Bulk fill via the existing product CSV import (two new columns). Required on create/edit while ETA is enabled; a sale line without one is refused `422 ETA_ITEM_CODE_MISSING`. For inventory-linked shops the fields are POS-owned and catalog sync never overwrites them. |
| E6 | Documents | Sale → **Receipt v1.2 `s`**. Refund → **Return Receipt v1.2 `r`** of the refunded lines, `referenceUUID` = the sale receipt's UUID. **Void → a full Return Receipt** of every line (ETA has no POS-side cancel [S2, S6]). A refund of a sale made before ETA was enabled → **Return Receipt Without Reference** with the matching `documentUseReason` code [unverified: code values, page did not load]. |
| E7 | Numbers | `receiptNumber`: sale = `Sale.number`; refund = `{sale}-R{n}` (n = the refund's order on the sale); void = `{sale}-V`. Unique per branch as ETA requires. `dateTimeIssued` = commit time in UTC, seconds precision, `Z`. |
| E8 | Header, seller, buyer | `currency` `EGP` (no exchange rate). Seller from `EtaLink` + branch + device (`deviceSerialNumber` = `posSerial`). Buyer: walk-in → `{ type: "P" }`; customer with a tax number → `{ type: "B", id: taxNumber, name }`; customer without → `{ type: "P", name, mobileNumber }`. **A sale ≥ 150,000 EGP without a `B` buyer is refused at checkout** `422 ETA_BUYER_ID_REQUIRED` (we store no national IDs; adding one is out of scope). |
| E9 | Lines and money | Decimal strings with 2 places from minor units (5 for `unitPrice`). From each `SaleItem` (re-priced with `priceLine` at discount 0 for the pre-discount figures): `internalCode` = SKU, `description` = name (EN, AR appended when set), `unitType` EACH → `EA`, KG → `KGM` [unverified codes], `quantity` = qty, `totalSale` = net before discount, `commercialDiscountData` = `[{ amount: totalSale − netSale, description: "Discount" }]` when non-zero (net of VAT, so VAT stays on what is left as in discounts-spec DC2/DC5), `netSale` = `lineTotalMinor − vatMinor`, `unitPrice` = `totalSale / qty`, `taxableItems` = one T1 entry, `total` = `lineTotalMinor`. Header totals are the sums ETA defines; `feesAmount`/`adjustment` 0; no `extraReceiptDiscountData` (the sale discount is already spread over the lines, DC4). |
| E10 | VAT codes | `STANDARD` → `T1`/`V009` at the line's rate; `EXEMPT` → `T1`/`V003` rate 0; `ZERO_RATED` → `T1`/`V010` ("Other Rates") rate 0 [unverified: confirm with the owner's accountant in preprod; V001/V002 are exports only]. `taxTotals` = one `T1` sum. |
| E11 | Payment | One code per receipt: the largest tender of the sale (ties: first). `CASH` → `C`, `CARD_MANUAL` → `V`, `WALLET` → `O`. A refund uses its own method. The card/wallet reference goes into `buyer.paymentNumber`. |
| E12 | UUID | Computed **in the sale/refund/void transaction**: lock the register's `EtaDevice` row (`SELECT … FOR UPDATE`), build the document with `previousUUID` = `lastUuid` (`""` for the device's first), `uuid` = `""`; serialize with ETA's rule (property names uppercased, every name and simple value in double quotes, objects recursed, an array name emitted once and again before each element, values exactly as written, no whitespace) [S8]; SHA-256; 64-char lowercase hex [S5, S10]; set `uuid`, write `lastUuid`. The frozen JSON is stored so a resend is byte-identical. Pure function `etaUuid(doc)` in `modules/integrations/eta/uuid.ts` with golden tests from ETA preprod [unverified until preprod accepts our hashes]. |
| E13 | Queue | New `EtaReceipt` table, modelled on `ExternalStockPosting`: `orgId`, `registerId`, `sourceType` (`Sale`/`Refund`/`Void`), `sourceId`, `receiptNumber`, `uuid` (unique), `previousUuid`, `document` Json, `issuedAt`, `status` (`PENDING` → `SUBMITTED` → `VALID` \| `INVALID`; `FAILED`), `submissionUuid`, `attempts`, `nextAttemptAt`, `lastErrorCode`, `errors` Json (ETA's `propertyPath`/`errorCode`/`error` only). Written in the POS transaction; `postAfterCommit`-style send capped at 2 s; the rest drained by the existing minute scheduler. Batches per device in chain order, at most 50 per call [unverified size limit; `MaximumSizeExceeded` halves the batch]. |
| E14 | Retries | Network errors, 5xx and 429 → `PENDING` with `BACKOFF_MINUTES` (1, 2, 5, 15, 30, 60). `422 DuplicateSubmission` → wait `Retry-After`, then **poll the earlier `submissionUuid`** instead of resending (ETA asks that 20x answers are never resent [S7]). 401 → refresh the token once. `400 BadStructure`/`403 IncorrectSubmitter` → `FAILED` (a person must look). Accepted documents go `SUBMITTED`; their status is polled by `submissionUuid` at 1, 2, 5 … minutes until `Valid`/`Invalid`. ETA's push notifications (`PUT /notifications/receipts`, recommended over polling [S7]) are a later upgrade. |
| E15 | Rejections | `INVALID` rows show their ETA errors; the fix is a **corrected receipt**: same `previousUUID`, new UUID, `referenceOldUUID` = the rejected one [S5]; later receipts are untouched. Owner/manager action "Resend corrected" after fixing the cause (e.g. an item code). A return referencing an `INVALID` sale waits until the sale's correction is `VALID` and then references it. |
| E16 | Visibility | Back-office **ETA receipts** page (owner, admin, manager): counts by status, filters, ETA errors per row, retry/resend actions. A banner on the dashboard and till when anything is `FAILED`/`INVALID`, or `PENDING` older than 12 h ("submit before 24 h"). Audit: `eta.receipt.resent`, `eta.receipt.failed`. |
| E17 | ETA unreachable | **Never blocks a sale, refund or void**: the UUID and QR are local, so the slip prints at once and the row waits in the queue. Past 24 h rows are flagged **Late**; the owner raises a Late Submission Request on the portal and presses "Retry late receipts". Disabling ETA keeps draining what is already queued. |
| E18 | Printed receipt | Sale, refund and void slips of an ETA shop print a **QR** of `{portal}/receipts/search/{uuid}/share/{dateTimeIssued}` followed by `#` and the seller RIN and receipt total on one line [S5; unverified: exact suffix format and portal hosts], the UUID under it (short form), the ETA branch code and POS serial. Reprints show the same QR. `ReceiptDoc` gains `eta: { uuid, qrUrl } \| null`; QR drawn with the library the ZATCA QR work adds. |
| E19 | Returns rules | A refund more than **540 days** after its sale is refused in an ETA shop `422 ETA_RETURN_TOO_OLD`. Partial refunds return only their lines/qty; amounts come from `RefundItem` (`amountMinor`, `vatMinor`) so they never exceed the sale. |
| E20 | Environments | `EtaLink.environment` picks the hosts (preprod: `api.preprod.invoicing.eta.gov.eg` / `id.preprod.eta.gov.eg`; prod: `api.invoicing.eta.gov.eg` / `id.eta.gov.eg`) [unverified: taken from third-party SDK defaults, not ETA's pages]. Hosts live in one constant map, not tenant input. Switching to `PROD` needs fresh device credentials and resets every `lastUuid`. |
| E21 | Signatures | Not sent: the issuer CAdES signature is listed but "not yet deployed" [S2]. Revisit if ETA enforces it (it would need the taxpayer's e-seal token, a hardware USB device). |

## 3. Test plan

1. **Unit**: `etaUuid` golden vectors (ETA preprod receipts we submit and see `Valid`, plus the SDK sample), the
   serializer on arrays and decimals, document builder per case (discounted line, exempt, zero-rated, KG, split
   tender, B buyer, ≥ 150k refusal, refund, void, without-reference).
2. **Integration** (Postgres, fake ETA server like the IMS fake): chain order under concurrent sales on one register,
   queue retries/backoff, duplicate → poll, invalid → corrected resend, return waiting on its sale, outage never
   blocking checkout.
3. **Preprod run** with the owner's preprod credentials: one register, ~30 receipts covering every case above, all
   `Valid` on the preprod portal and the QR opening the right receipt. Then production credentials on one branch for a
   day before all branches.

## 4. Slices

| Slice | Content | Effort |
|---|---|---|
| 1 | `EtaLink`, branch fields, `EtaDevice` (sealed secrets), product item codes + CSV columns, settings UI, readiness gate, token "Test connection" | 3 d |
| 2 | Document builder + `etaUuid` + unit golden tests (preprod access needed for the vectors) | 3 d |
| 3 | `EtaReceipt` queue in the sale/refund/void transactions, submit, poll, retries, back-office page, banners | 3–4 d |
| 4 | Receipt QR + UUID on slips, returns/voids/without-reference, 540-day and 150k rules, corrected resend | 2 d |
| 5 | Preprod certification run and production cut-over with the owner | 1–2 d + owner time |

## 5. Risks

- **UUID canonicalization** is the make-or-break: one formatting difference (decimal places, field order, empty
  arrays) and every receipt is rejected. Mitigated by building slice 2 against preprod, not docs alone.
- **Rounding**: VAT-inclusive shelf prices give net unit prices with more than 2 decimals; ETA may check
  `quantity × unitPrice` against `totalSale` with a tolerance we have not seen documented.
- **Credentials and portal steps** sit with the owner and ETA; slice 1 cannot be tested end to end until they exist.
- **Unverified codes and hosts** (unit types, zero-rated subtype, no-reference reasons, QR suffix, base URLs) are
  flagged above; each is a constant, cheap to change.
- **Late submissions** consume a yearly quota; a long outage on our side (scheduler down) is a compliance risk, hence
  the 12 h banner.
- **Throttling** numbers are not published [S7]; batching and the 2 s after-commit cap keep call volume low.

## 6. Sources

- [S1] Authenticate POS — https://sdk.invoicing.eta.gov.eg/ereceiptapi/01-authenticate-pos/
- [S2] Submit Receipt Documents — https://sdk.invoicing.eta.gov.eg/ereceiptapi/02-submit-receipt/
- [S3] Receipt v1.2 — https://sdk.invoicing.eta.gov.eg/documents/receipt-v1-2/
- [S4] Return Receipt v1.2 — https://sdk.invoicing.eta.gov.eg/documents/return-receipt-v1-2/
- [S5] Receipt Issuance FAQ — https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/
- [S6] Get Receipt Submission — https://sdk.invoicing.eta.gov.eg/ereceiptapi/06-get-receipt-submission/
- [S7] Integration Practices — https://sdk.invoicing.eta.gov.eg/integrationpractices/
- [S8] Document serialization approach — https://sdk.invoicing.eta.gov.eg/document-serialization-approach/
- [S9] Document types — https://sdk.invoicing.eta.gov.eg/types/ ; codes: https://sdk.invoicing.eta.gov.eg/codes/
  (payment methods, tax types)
- [S10] Third-party UUID sample (Chilkat, not authoritative) —
  https://example-code.com/powershell/itida_egypt_ereceipt_uuid.asp ; preprod host default seen in the EtaInvoice.Net
  package — https://www.nuget.org/packages/EtaInvoice.Net

## 7. Out of scope

B2B e-invoices (the separate ETA e-invoice system), national ID capture, the issuer e-seal signature, ETA push
notifications, restaurant/services receipt types, receipt package downloads, and SA (ZATCA) — covered by its own spec.
