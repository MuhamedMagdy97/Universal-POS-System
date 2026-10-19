# Manager guide

For branch managers. You can do everything in the [cashier guide](cashier.md) (sell, open and close shifts, cash in
and out), plus refunds, voids, stock, receiving deliveries and reports, at the branches you are assigned to. You cannot
change products or prices, raise purchase orders, see costs in the catalog, or change settings and staff. Arabic
labels are in brackets.

## Working a till

Same as a cashier: **Till** [نقطة البيع] → pick branch and register → **Open shift** → sell → **Close shift**. You can
also record **Pay-out** and **Drop to safe**, and close a shift someone else opened (e.g. at end of day).

## Returns: find a sale

1. Press **Returns** [المرتجعات].
2. Type the sale number from the receipt in **Receipt number** [رقم الإيصال] (e.g. 000123) and press **Find sale**
   [بحث عن البيع].
3. The sale opens with its time, till, lines and total. **Reprint receipt** [إعادة طباعة الإيصال] prints a copy
   marked "Copy".

"No sale with that number." — wrong number, or the sale belongs to a branch you are not assigned to.

## Refund some or all items

A refund gives money back for chosen lines and puts the items back into the branch's stock.

1. In **Refund qty**, type how many of each line to refund (up to what is left; "Refunded" shows what was already
   refunded).
2. **Pay out from till** [الصرف من الكاشير]: the till that pays. It must be in the sale's branch and have an open
   shift. The sale's own till is chosen when its shift is open, otherwise the first open till. Tills without an open
   shift show "(no open shift)".
3. **Refund method** [طريقة الاسترداد]: Cash, Card or Wallet, with an optional reference for card or wallet. A cash
   refund comes out of that till's drawer and shows as "Cash refunds" when the shift closes.
4. Type a **Reason** [السبب] (required).
5. Press **Refund {total}** [استرداد]. You see "Refunded {total}." and the refund appears under **Refunds on this
   sale**, with a **Print** button for the refund slip.

Refusals:

| Message | Meaning |
|---|---|
| "No till in this branch has an open shift. Open one on the till before refunding." | Open a shift on any till in the sale's branch first. This applies to card and wallet refunds too. |
| "Enter a whole number up to the quantity left." | A quantity is too high or not a whole number. |
| "Everything on this sale has been refunded." | Nothing is left to refund. |
| "Part of this sale was refunded meanwhile. The page was reloaded; check the quantities." | Someone else refunded at the same time. |
| "The chosen till has no open shift any more. Pick another till or open a shift." | |
| "This sale was voided, so it can't be refunded." | |
| "This refund comes to zero, so there is nothing to give back." | |

There are no exchanges, refunds without a receipt number, store credit or approval limits.

## Void a whole sale

A void cancels the whole sale (a mistake at the till) and returns all its stock. It is allowed **only while the sale's
shift is still open and before any refund**. Otherwise refund the lines.

1. Find the sale, then under **Void sale** press **Void sale** [إلغاء البيع].
2. Type the **Reason for the void** [سبب الإلغاء] (required) and press **Confirm void** [تأكيد الإلغاء].
3. Press **Print void slip** [طباعة إيصال الإلغاء] if the customer needs one.

Refusals: "This sale can't be voided: its shift is closed or it has refunds. Refund the lines instead.", "This sale's
shift is closed, so it can't be voided. Refund it instead.", "This sale has refunds, so it can't be voided. Refund the
remaining lines instead."

## Stock

**Inventory** [المخزون] lists on-hand stock for one branch. Search by name, SKU or barcode, filter by In stock / Zero /
Negative / No opening stock. Each row has:

- **Adjust** [تعديل]: pick a **Reason** (Damaged, Expired, Lost or stolen, Count correction, Found, Other), then
  **Change by** (Add / Remove) or, for Count correction, **Set counted quantity**. Other needs a note. Press **Save
  adjustment** [حفظ التعديل].
- **Transfer** [تحويل] / **New transfer**: choose **To branch**, add items and quantities, press **Transfer stock**
  [تحويل المخزون]. Stock moves at once (no in-transit step).
- **History** [السجل]: every movement for the item with who did it.

**Opening stock** [الرصيد الافتتاحي] records the first quantity of items that never had stock at this branch, once
per item, up to 100 items per save. Press **Save opening stock** [حفظ الرصيد الافتتاحي].

Refusals: "Not enough stock. The change would take the balance below zero.", "This reason cannot move stock in that
direction." (e.g. Damaged can only remove), "The counted quantity matches the current stock.", "Add a note for
Other.", "Stock changed to {onHand} while you were editing. Check it and confirm again.", "Choose a different branch
to transfer to.", "Some items already have opening stock here. Remove them and save again."

## Receive a delivery

The owner or admin raises purchase orders; you receive them at your branches.

1. **Purchasing** [المشتريات] → open an order that is **Ordered** or **Partly received**.
2. Press **Receive goods** [استلام البضاعة].
3. **Receiving now** starts at what is outstanding: change it to what actually arrived, or use **Receive all**
   [استلام الكل] / **Receive nothing**. Check the unit cost against the supplier's paper.
4. Press **Receive {units} units** [استلام {units} وحدة]. Stock goes up at once.

Refusals: "Enter a quantity for at least one line.", "A quantity is more than is still outstanding. Reload to see the
latest.", "This order cannot be received now." (draft, cancelled or fully received). Returning goods to a supplier is
not built.

## Reports

**Reports** [التقارير]: pick a **Report**, a **Branch** (or **All my branches** [كل فروعي]), dates or a quick range
(Today, Yesterday, This week, This month, Last month), press **Show** [عرض]. **Export CSV** [تصدير CSV] downloads all
rows; the screen shows the first 500.

Managers and reporting users see: Sales summary, Payments, Products, Categories, Cashiers, Shifts (with a Z-report
print button on closed shifts), Refunds and voids, VAT. Profit and Purchases received are for the owner and admins.

Days run midnight to midnight in Cairo or Riyadh time. A report covers at most 366 days ("Check the dates…").

The **Dashboard** shows today's net sales, number of sales, refunds and open shifts; each tile opens its report.

Not built: charts, scheduled or emailed reports. See [known limitations](../product/known-limitations.md).
