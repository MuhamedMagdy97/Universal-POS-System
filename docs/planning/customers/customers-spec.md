# Customer records: Specification

Status: **Spec approved by the owner (2026-10-20, every decision as recommended). BUILT on the "Customers: records and
sale history" PR.**

Source: `docs/product/known-limitations.md` ("Walk-in customers only: no customer records"), the as-built
`modules/sales` (`create.ts`, `receipt.ts`, `refunds.ts`), `modules/reports` and `lib/auth/permissions.ts`.

## 1. Key facts

- A sale has no customer today. Receipts print the shop, the lines and the payments.
- The idempotency request hash is taken over the parsed request body, so any new optional field is hashed only when
  sent (a request without it hashes exactly as before).
- Refunds and voids always belong to one sale.
- Shops linked to the inventory system reserve and fulfil quantities around `createSale`; money and people never go
  to the inventory system.
- Every shop is in Egypt (EG, +20) or Saudi Arabia (SA, +966).

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| CU1 | Fields | `Customer`: **name** (1–120), **phone** (required), optional **email**, optional **tax/VAT number** (≤ 40, for B2B receipts), optional **note** (≤ 500), **isActive**. No birthday, address, gender, consent or marketing fields: personal data stays minimal. |
| CU2 | Phone | Stored in **E.164** (`+201001234567`). Input may use spaces, dashes, brackets, a leading `+`/`00`, the country code without `+`, and Arabic-Indic digits. A local number is read in the shop's country: EG mobile `01[0125]` + 8 digits, EG landline `0[2-9]` + 7–8 digits; SA mobile `05` + 8 digits, SA landline `01[1-7]` + 7 digits. A foreign number must be typed with `+` or `00` (8–15 digits). Anything else is a 422 `INVALID_PHONE`. Pure function `normalizePhone` in `modules/customers/phone.ts`. |
| CU3 | Uniqueness | Phone is **unique per organization** (DB unique index on `(orgId, phone)`, archived customers included). A clash is 409 `PHONE_TAKEN` with the existing customer's id, so the till can offer to pick them. Names are not unique. |
| CU4 | Lifecycle | Created, edited, **archived** and restored; never deleted (sales point at them). Archived customers are hidden from the till search and cannot be put on a new sale (409 `CUSTOMER_INACTIVE`); their history stays. |
| CU5 | Audit | `customer.created` (name), `customer.updated` (changed field names only, no values), `customer.archived`, `customer.restored`. Denied attempts write `customers.permission.denied`. |
| CU6 | Permissions | Three new grants. `customers.read`: search, list, view history. `customers.create`: add one (quick-add at the till). `customers.manage`: edit, archive, restore. **Cashier**: read + create. **Manager, Admin, Owner**: all three. **Reporting**: read. Admin cannot sell, so it only manages the records. |
| CU7 | On a sale | `POST /api/sales` (and the till action) takes optional `customerId`. Walk-in (no customer) stays the default. Attaching one needs `customers.read`; the customer must be in the same org (else 404) and active (else 409). |
| CU8 | Snapshot | The sale stores `customerId` plus `customerName`, `customerPhone`, `customerTaxNumber` as they were at sale time. Receipts and reprints read the snapshot, so a later edit never changes a printed slip. A DB check keeps id and name together (both set or both null). |
| CU9 | Idempotency | `customerId` is part of the request body, so it is part of the request hash: the same key with another customer (or none) is 409 `IDEMPOTENCY_CONFLICT`. |
| CU10 | Refunds and voids | Unchanged. They hang off the sale, so they keep its customer: the refund and void receipts print the sale's customer, and the customer's history lists refunds of their sales. |
| CU11 | Receipt | Sale, refund and void slips print "Customer: {name}" and, when set, "Customer VAT no. {number}". The phone is **not** printed (it is personal data the slip does not need). |
| CU12 | Till | A "Customer" row above the cart: **F9** focuses the customer search (phone or name, at least 2 characters, up to 10 active matches; ↑/↓ and Enter pick, Esc closes). "Add customer" opens a name + phone quick-add that attaches the new customer. A chosen customer can be removed (back to walk-in). "New sale" resets to walk-in. |
| CU13 | Back office | `/customers` (`customers.read`): search by name or phone, show archived, add/edit/archive/restore with `customers.manage` (add with `customers.create`). `/customers/{id}`: details, totals and purchase history. |
| CU14 | History | Totals over all the customer's sales in the caller's branch scope: completed sales count and amount, refunds count and amount, net (completed − refunded). Lists show the latest 100 sales (number, time, branch, total, status) and the latest 100 refunds (time, sale number, amount). Voided sales are listed with their status and left out of the totals. |
| CU15 | Report | New canned report **"Sales by customer"** (`customers`) in `modules/reports`: one row per customer with a completed sale or a refund in range (name, phone, sales count, sales, refunds count, refunds, net), largest first. Walk-in sales are not a row. Needs `reports.view` **and** `customers.read`. CSV through the existing export (audited `reports.exported`). |
| CU16 | Isolation | Every query filters by `orgId`; the sale→customer foreign key is composite `(orgId, customerId)`, so the database refuses a sale pointing at another tenant's customer. |
| CU17 | Linked shops | Same behaviour. A customer never changes quantities; the customer check runs before anything is held in the inventory system, so the reserve/fulfil path is untouched. |
| CU18 | Migration | One migration: `Customer` table (unique `(orgId, id)`, unique `(orgId, phone)`, index `(orgId, name)`, E.164 check), four nullable `Sale` columns, composite FK, index `(orgId, customerId, createdAt)`. |

## 3. API

| Method | Path | Grant | Body / query → result |
|---|---|---|---|
| GET | `/api/customers?q&includeArchived&limit` | `customers.read` | → `CustomerRow[]` (name or phone match) |
| POST | `/api/customers` | `customers.create` | `{ name, phone, email?, taxNumber?, note? }` → 201 `CustomerRow` |
| GET | `/api/customers/{id}` | `customers.read` | → `CustomerDetail` (row + totals + history) |
| PATCH | `/api/customers/{id}` | `customers.manage` | any of the create fields, or `{ isActive }` → `CustomerRow` |

`SaleDetail` gains `customer: { id, name, phone, taxNumber } | null`; `ReceiptDoc` gains
`customer: { name, taxNumber } | null`.

## 4. Out of scope

Loyalty points, credit accounts (pay later), customer-specific prices, marketing consent and messaging, merging
duplicates, importing customers, and sending customers to the inventory system.
