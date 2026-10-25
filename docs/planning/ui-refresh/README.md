# UI Refresh and Business Views: Overview

Status: **Split and order approved by the owner (2026-10-24).** Each sub-project gets its own spec, approved before it
is built.

Goal: a polished app in English and Arabic, with a view made for each business type (`BusinessType`: retail, grocery,
fruit and vegetables, bakery and butcher, restaurant and café, salon), including the vertical features each one is
missing today.

| #   | Sub-project               | Business types                     | Back end                | Spec                                           |
| --- | ------------------------- | ---------------------------------- | ----------------------- | ---------------------------------------------- |
| A   | Design system + app shell | All                                | None                    | [design-system-spec.md](design-system-spec.md) |
| B   | Business profiles         | All                                | Search API, one setting | [business-profiles-spec.md](business-profiles-spec.md) |
| C   | Weighed selling           | Grocery, fruit & veg, bakery/butcher | Migration, money paths | [weighed-selling-spec.md](weighed-selling-spec.md), [as built](weighed-selling-as-built.md) |
| D   | Restaurant / café         | Restaurant and café                | Migrations              | [restaurant-cafe-spec.md](restaurant-cafe-spec.md), [as built](restaurant-cafe-as-built.md) |
| E   | Salon                     | Salon                              | Migrations              | Not written                                    |

Order: A, then B. C, D and E each build on B and not on each other; C goes first because three business types need it.

- **B** One profile per business type: accent colour and icon, wording ("Product" / "Service" / "Menu item"),
  dashboard tiles, and the till layout (scan-first for retail, tap tiles by category for café and salon, weight-first
  for grocery and butcher). The till (`app/(app)/pos/_components/till.tsx`, 1,100 lines) is split into parts the
  layouts share.
- **C** Selling by kilogram (quantity in grams): price per kg, a typed weight, scale-label EAN-13 barcodes with
  embedded weight or price, and the effect on stock, VAT, refunds, offline sales and reports. Built 2026-10-25.
- **D** Dine-in, takeaway and delivery orders; tables with open tickets (hold, pay later); modifiers; service charge;
  a kitchen ticket print.
- **E** Service items with no stock, the staff member on each line, an appointments calendar, a commission report.
