# User guide

How to use Universal POS screens, by role. Written from the screens as built (October 2026).

| You are… | Read |
|---|---|
| A **cashier** at the till | [cashier.md](cashier.md) |
| A **branch manager** (you also sell and close shifts) | [cashier.md](cashier.md), then [manager.md](manager.md) |
| The **owner** or an **admin** setting up and running the shop | [owner.md](owner.md) (owners who sell: also [cashier.md](cashier.md)) |
| A **reporting** user (read-only) | [manager.md § Reports](manager.md#reports) |

## Language

Every signed-in screen works in English and Arabic. Press **عربي** in the top bar to switch to Arabic (the page turns
right-to-left); press **English** to switch back. The choice is remembered on that browser. Product names show in
Arabic when the product has an Arabic name. Numbers can be typed with Arabic-Indic digits (٠١٢…).

## What each role can open

The top bar only shows links you are allowed to use. If you open a page by its address without the right, you see a
"You can't…" message instead.

| Screen (top bar) | Owner | Admin | Manager | Cashier | Reporting |
|---|---|---|---|---|---|
| Till · نقطة البيع | ✓ | – | ✓ | ✓ | – |
| Returns · المرتجعات (refund, void) | ✓ | – | ✓ | – | – |
| Customers · العملاء | edit | edit | edit | view, add | view |
| Catalog · الكتالوج | edit | edit | view | view | – |
| Inventory · المخزون | ✓ | ✓ | ✓ | – | view |
| Purchasing · المشتريات | ✓ | ✓ | receive only | – | – |
| Reports · التقارير | all | all | sales reports | – | sales reports |
| Audit trail · سجل التدقيق | ✓ | ✓ | – | – | – |
| Settings · الإعدادات | ✓ | ✓ | – | – | – |
| My account · حسابي | ✓ | ✓ | ✓ | ✓ | ✓ |

"Sales reports" means every report except **Purchases received** and the three **Profit** reports, which show cost.

Each person also only sees the **branches** they were given (or all branches). Branches outside your list are not shown
and their data is refused as "not found".

## What isn't there yet

See [known limitations](../product/known-limitations.md): for example offline selling is sales only, no promotions or coupons, no tax
e-invoices (ZATCA / Egypt e-receipt), no customer records, no email (password resets are done by an owner or admin).
