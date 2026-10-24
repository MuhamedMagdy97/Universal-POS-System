# Weighed Selling (UI Refresh C): Specification

Status: **Draft for the owner's review (2026-10-24).** Design approved in conversation with every choice as
recommended.

Source: [overview](README.md), [business profiles as built](business-profiles-as-built.md),
`docs/product/known-limitations.md` ("Only `EACH` units: `KG` / weighted selling is refused with
`UNIT_NOT_SUPPORTED`; quantities are whole numbers"). Today `UnitType` has `EACH` and `KG`, product create refuses
`KG`, every quantity column is an integer, and money is `unitPriceMinor × qty` (`modules/sales/totals.ts`). Products
synced from the inventory system already map its `kg` unit to `KG` and are sellable, so 1 sold means 1 kg.

## 1. Goal

Grocery, fruit and vegetable, bakery and butcher shops sell by weight: price per kg, a weight typed at the till or
read from a scale label, correct totals, VAT, stock, refunds, purchases, counts, reports and offline sales.

## 2. Decisions

| #   | Question                         | Decision (recommended)                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | How is a weight stored?          | As an integer number of **grams** in the existing quantity columns (sale, refund, stock balance and movement, purchase, receipt, return, count, transfer lines). For `EACH` the number stays pieces. No column changes type; ledger, idempotency and reconciliation stay as they are. The per-line maximum (1,000,000) is 1,000 kg.                               |
| W2  | Price and cost                   | `priceMinor` and `costMinor` of a KG product are **per kg**.                                                                                                                                                                                                                                                                                                   |
| W3  | Money                            | One helper, `lineMinor(unitPriceMinor, qty, unitType)`: `EACH` → `price × qty`; `KG` → `round(price × grams / 1000)`, half up. Every place that multiplies a price or cost by a quantity uses it: till and offline totals, sale create, refunds, voids, cost snapshot and profit, purchase lines, receipts and supplier documents, stock valuation if any. VAT and discounts work on the line total as today. |
| W4  | Creating KG products             | Allowed for products without variants; `unitType` stays fixed after create (as today). A product with variants stays `EACH`. Product CSV import accepts `unitType` `KG`.                                                                                                                                                                                      |
| W5  | The till                         | Adding a KG item (search, tile or barcode) opens a **weight box**: type kg with up to 3 decimals (`0.750`), Enter adds the line, Esc cancels. The cart line shows `0.750 kg × EGP 120.00/kg`; its quantity field edits the weight in kg; `+` / `-` step 0.1 kg. Weights from 0.001 to 1,000 kg.                                                                       |
| W6  | Scale labels                     | A shop setting (Owner, off by default): label prefix (one or more 2-digit prefixes starting with `2`, default `20`–`29`), item-code length (default 5) and value kind (**weight** in grams, or **price** in minor units, 5 digits). A 13-digit code with a matching prefix and a valid EAN-13 check digit is a label: prefix + item code is looked up as an existing **barcode** of the product (no new column). Weight labels set the grams; price labels keep the printed price as the line total and derive grams = round(price × 1000 / price per kg). A label for an `EACH` product, an unknown item code or a bad check digit is refused with a clear message. |
| W7  | Stock, purchasing, counts        | Every quantity of a KG item is entered and shown in kg with 3 decimals (opening stock, adjustments, transfers, counts, purchase orders, receipts, returns, reorder points, low stock, stock CSV import). Validation converts kg to grams and refuses more than 3 decimals.                                                                                       |
| W8  | Refunds and voids                | A partial refund of a KG line is entered in kg up to the weight sold, with the existing remainder rounding; a void returns the whole weight to stock.                                                                                                                                                                                                           |
| W9  | Receipts, reports, CSV           | Receipts and Z-reports show `0.750 kg × 120.00`. Report quantity columns show kg (3 decimals) for KG rows; CSV writes the same text with the unit, so a pieces row and a kg row are never added up by mistake. Top items today ranks KG items by sale count, not grams.                                                                                         |
| W10 | Offline till                     | The snapshot already carries `unitType`; offline pricing uses `lineMinor`, so weighed sales work offline and replay unchanged.                                                                                                                                                                                                                                   |
| W11 | Shops linked to the inventory system | KG items synced from the inventory system are **not sellable** (reason `UNIT`, shown at the till as today's other reasons) until the inventory system confirms how it takes decimal quantities. This closes today's "1 sold = 1 kg" gap. Wiring it is a follow-up.                                                                                     |
| W12 | Migration                        | One: the scale-label settings on `Organization` (`scaleLabelPrefixes String[]`, `scaleItemDigits Int`, `scaleValueKind` enum `WEIGHT`/`PRICE`, `scaleLabelsEnabled Boolean`), audited like other settings.                                                                                                                                                         |

## 3. Out of scope

Reading a connected scale (USB, serial, network); tare; units other than kg (grams-priced items, litres, metres); a
price-per-100 g display; weighed variants; printing scale labels.

## 4. Tests

- Unit: `lineMinor` (1 g, half-up at .5, 1,000 kg, `EACH` unchanged); kg parsing and formatting (EN/AR digits,
  3 decimals, refusals); EAN-13 label parsing (weight, price, bad check digit, unknown prefix, `EACH` product).
- Integration: a weighed sale's totals, VAT and stock; refund of part of a weight and a void; purchase receipt in kg
  and last cost per kg; a count correction in kg; an offline sale of a KG item replayed; `expectReconciled` after each;
  KG create refused for a product with variants; linked-shop KG item refused at sale.
- E2E: a grocery shop sells 0.750 kg from search and from a scale label; refunds 0.250 kg; the receipt shows kg; the
  till in Arabic RTL.

## 5. Delivery

Three PRs, merged in order:

1. `lineMinor`, KG products, the till weight box, receipts, refunds and voids, offline.
2. Stock, purchasing, counts, transfers, imports, reports and CSV in kg.
3. Scale-label setting and parsing (the one migration), linked-shop KG items not sellable.
