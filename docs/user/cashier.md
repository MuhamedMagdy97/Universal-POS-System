# Cashier guide

For cashiers, and for managers and owners when they work a till. Arabic labels are in brackets.

## Sign in

1. Open the shop's address, press **Sign in** [تسجيل الدخول], enter the email and password your owner or admin gave you, press
   **Sign in**.
2. You land on the **Dashboard** [لوحة التحكم]. Press **Till** [نقطة البيع] in the top bar.

Refusals:
- "Email or password is incorrect." Check both; there is no "forgot password" link. Ask your owner or admin for a new
  password.
- "Too many attempts. Wait a minute and try again."

To change your password: **My account** [حسابي] → current password, new password (at least 10 characters) →
**Change password** [تغيير كلمة المرور]. Your other devices are signed out. Press **Sign out** [تسجيل الخروج] when you leave.

## Pick your till

The Till page opens on your branch and its first till. To use another one, choose **Branch** [الفرع] and
**Register** [الصندوق], then press **Switch** [تبديل]. You only see branches you are assigned to.

- "This branch has no registers. Ask an admin to add one."
- "Branch not found" — the branch is not one of yours, or was deactivated.

## Open a shift

If the till shows "No open shift on this register":

1. Count the cash in the drawer and type it in **Opening cash in the drawer** [النقدية الافتتاحية في الدرج]
   (0 is allowed).
2. Press **Open shift** [فتح الوردية].

Refusals:
- "Enter the cash in the drawer, for example 0 or 500."
- "A shift is already open on this register. Reloading…" — someone opened it first; the page reloads into that shift.
- "You can't open a shift here. Ask a manager."

One till has at most one open shift. Anyone allowed to sell can sell on an open shift, not only the person who opened it.

## Sell

1. **Scan** the barcode, or type a barcode, SKU or name in **Barcode, SKU or name** and press Enter or **Find**
   [بحث].
   - One match goes straight into the sale. Several matches show a list: press **+** next to the item.
   - Scanning the same item again adds 1 to its line.
   - "No items match." — wrong code, or the product is archived. Archived products cannot be sold.
   - **On hand: {qty}** [المتوفر] shows what this branch holds, next to each match and under each line of the sale.
     It is red when it is 0 or less, or less than the quantity in the sale. It is shown only: whether the sale goes
     through is decided when you charge (see "Not enough stock" below).
2. **Quantity:** type it in the **Qty** box, or press **+** / **−** on the keyboard to change the selected line (the
   one you scanned last or clicked into; it is shaded). Pieces are whole numbers, 1 or more. An empty box blocks the charge
   until you fix it. Press **×** to remove a line, or **Clear sale** [مسح البيع] to empty the sale.
   - **Weighed items** (sold per kg): finding one opens **Weight (kg)** [الوزن (كجم)]. Type the weight, up to 3
     decimals (0.750 = 750 g; a comma or ٫ works too), and press Enter or **Add**. Esc closes it. The line shows the
     weight in kg and the price per kg; **+** / **−** change it by 0.1 kg. The same item again adds its weight.
   - **Scale labels**: when the owner has turned them on, scan the label the scale printed. A weight label adds that
     weight; a price label adds the printed price and the weight it stands for. Changing that line's weight by hand
     prices it by weight again. "This scale label did not scan correctly" — scan it again or type the weight.
3. Check **Subtotal**, **VAT** and **Total** on the right. "Prices include VAT" means shelf prices already include it.
   The final numbers come from the server and are what the receipt shows.
4. Choose the **Payment method**:
   - **Cash** [نقدًا]: type **Cash received** [النقدية المستلمة]. The **Change** [الباقي] appears. When the customer
     pays the exact amount, press **Exact cash (F8)** [المبلغ المضبوط] instead of typing it. "Cash received is less
     than the total." if it is short.
   - **Card** [بطاقة] or **Wallet** [محفظة]: the full total is taken. **Reference** is optional (e.g. the last 4
     digits or the wallet transaction number). Card and wallet are recorded by hand: take the payment on your own card
     machine or wallet app first.
   - **Split** [تقسيم]: type an amount for any of Cash, Card and Wallet. **Remaining** [المتبقي] shows what is left.
     Card and wallet together cannot be more than the total; only cash gives change. Do not add cash when card and
     wallet already cover the total. "The amounts don't cover the total. Card and wallet can't exceed it; only cash
     gives change." **Exact cash** next to the cash amount fills in what card and wallet leave unpaid.
5. Press **Charge {total}** [تحصيل]. A sale that totals 0 shows **Complete free sale** [إتمام بيع مجاني] instead.

### Customer

Every sale is a walk-in sale unless you add a customer. Add one when the customer asks for their name or their
company's VAT number on the receipt.

- Press **F9** (or click the **Customer phone or name (F9)** [هاتف العميل أو اسمه] box) and type at least 2 characters
  of their phone or name. Matching customers appear: press ↑ / ↓ and Enter, or click one. Esc closes the list.
- The customer shows above the sale with their phone (and VAT number if they have one). **Remove customer**
  [إزالة العميل] makes it a walk-in sale again. **New sale** always starts as walk-in.
- **New customer:** press **Add customer** [إضافة عميل], type the name and phone, and press **Add and use**
  [إضافة واستخدام]. A typed phone is filled in for you. Local numbers are fine (0100 123 4567, 050 123 4567);
  a foreign number needs + or 00 in front.
  - "Enter a valid mobile or landline number." — check the number.
  - "A customer with this phone already exists." — they are already saved: they are listed, pick them.
- Archived customers are not found. Only a manager can edit or archive a customer.
- "This customer is archived. Pick another or sell as walk-in." after **Charge**: remove the customer and charge again.

### Discounts

You can take money off one line, or off the whole sale, as a percent or an amount.

- **Line:** press **Discount** [خصم] on the line, or select the line and press **F6**.
- **Whole sale:** press **Sale discount (F7)** [خصم على البيع] under the totals, or press **F7**.
- In the box, type the number and pick **%** or **Amount**. Press Enter or **Apply** [تطبيق]. **Remove** [إزالة] (or an
  empty box) takes the discount off; Esc closes the box without changing anything.
- The line shows "Discount −{amount}" and the totals show **Discount** [الخصم]. A sale discount is shared across the
  lines in proportion to their prices, so a later refund gives back exactly what the customer paid for each item.
- VAT is worked out on the discounted price. The receipt shows each line's discount and the total discount.
- **Your limit:** the box shows "Your limit: {limit}" (10% unless the owner changed it). No line may be discounted
  more than that, and the whole sale not more than that in total, so a line discount and a sale discount together
  count against the same limit. Over it, "These discounts are over your limit of {limit}. Ask a manager." shows and
  **Charge** stays off. Managers and the owner have no limit.

### Keyboard

The keys are also listed under the search box.

| Key | What it does |
|---|---|
| Enter | In the search box: find (a scanner sends it). In a payment box: charge. |
| F2 | Go to the search box. |
| F4 | Pay in cash: picks **Cash** and goes to the cash box (the cash row in a split). |
| F6 | Discount on the selected line. |
| F7 | Discount on the whole sale. |
| F8 | **Exact cash**: fills the cash box with what is due in cash. Press Enter to charge. |
| F9 | Go to the customer box. |
| + / − | Add or take 1 from the selected line (not below 1). They work outside a box, or in the empty search box. |
| Esc | Close the discount box, the search results or the customer list, or cancel **Cash in / out** and **Close shift**. |

Refusals after **Charge**:

| Message | What to do |
|---|---|
| "Not enough stock: {items}" | The branch has no stock left for those items. Remove or reduce them, or ask a manager to check stock. |
| "The shift on this register is closed. Open a shift to continue." | Someone closed the shift. Open a new one. |
| "An item in the sale can no longer be sold. Remove it and try again." | It was archived while you were selling. |
| "The payment does not match the total." | Re-enter the payment. |
| "This sale is too large to record." | Split it into smaller sales. |
| "This discount is over your limit. Ask a manager." | Lower the discount, or ask a manager to ring up the sale. |
| "A discount is larger than the amount it comes off." | Lower the discount. |
| "This sale was already sent with different items. Start a new sale." | Press **Clear sale** and scan again. |
| "Something went wrong. Try again." | Press **Charge** again; the same sale is not recorded twice. |

## Options and notes

- An item with options (a size, extras) opens **Options for {item}** when you add it. The first choice of a "pick
  one" group is already chosen; tick what the customer wants and press **Add, {price}**. Esc cancels.
- The same item with other options, or with a note, is its own line. Press **Note** [ملاحظة] on a line, type
  "no onions" and press Enter. Notes print on the kitchen slip and the receipt.

## Restaurants and cafés

A café shop opens the till on **Tables** [الطاولات]: one tile per table, free, or with its open ticket's total and
minutes open. The owner sets the tables up in Settings → Tables.

1. **Dine-in:** press a free table. The bar shows "Table 4 · Ticket 12". Add what is ordered.
2. **Send to kitchen** [إرسال للمطبخ] saves the ticket and prints a kitchen slip with only what was not sent yet.
   Sent lines show **Sent 2**. Taking back something already sent needs a manager and prints a "CANCELLED" slip.
3. **Hold** [تعليق] saves the ticket and goes back to Tables. Any till in the branch can open it again.
4. **Pay:** open the ticket and charge as usual. The ticket closes and the table is free again.
- **Takeaway** and **Delivery:** pick the order type above the sale. Charge at once, or **Hold** to pay later (held
  orders are listed under Tables). Delivery needs the customer (F9) and takes the address.
- **Move** puts a dine-in ticket on another free table. **Cancel ticket** needs a reason, and a manager, once
  anything was sent.
- **Service charge:** when the owner has set one, dine-in orders show it before VAT. **Remove** takes it off this
  order only.
- Offline, the café till sells at the counter only: no tables or tickets until it is back online.

## Receipt and reprint

After the charge you see **Sale {number}** with the lines, totals, what was paid and the change.

- **Print** [طباعة] opens the browser print dialog for the receipt. Pick the receipt printer.
- With a customer, the receipt prints "Customer: {name}" and their VAT number if they have one (never their phone).
- **New sale** [بيع جديد] starts the next sale.
- **Reprint last receipt** [إعادة طباعة آخر إيصال] appears above the empty sale after that. It prints the last sale
  made on this screen, marked "Copy".

Older receipts are reprinted from **Returns** by a manager or owner (see [manager.md](manager.md)). The receipt is a
customer slip, not a tax e-invoice.

## Cash in and out of the drawer

Press **Cash in / out** [إدخال / إخراج نقد], choose the **Type**, type the **Amount** and a **Reason**, press
**Record** [تسجيل].

- **Pay-in** [إضافة نقد]: cash put into the drawer (e.g. extra change).
- **Pay-out** [مصروف نقدي]: cash paid out of the drawer (e.g. a small expense).
- **Drop to safe** [تحويل إلى الخزنة]: cash taken from the drawer to the safe.

Pay-out and drop only show if you may close shifts (cashiers can by default). Refusals: "Enter an amount above zero,
for example 50.", "You don't have permission to record this cash movement." If you see "No answer from the server.
Check the shift totals before trying again, or it may be recorded twice.", open **Close shift** and look at the
Pay-ins / Pay-outs / Drops lines before recording again. A recorded movement cannot be edited or deleted.

## Close the shift and count the cash

1. Press **Close shift** [إغلاق الوردية]. You see Opening cash, Cash sales, Pay-ins, Pay-outs, Drops, Cash refunds
   and **Expected in drawer** [المتوقع في الدرج].
2. Count the cash and type it in **Cash counted** [النقد المعدود]. The **Difference** [الفرق] shows.
3. If the difference is not zero, type the **Reason for the difference** [سبب الفرق]. You cannot close without it.
4. Press **Close shift**. Then press **Print Z-report** [طباعة تقرير الإغلاق] for the paper record, and **Done** [تم].

Card and wallet are not counted; only cash is. A closed shift cannot be reopened, and its sales can no longer be
voided (only refunded).

Refusals:
- "Enter the cash counted, for example 0 or 500."
- "Add a reason for the difference before closing." — cash moved while you counted; the expected cash was refreshed.
  Check it and add a reason.
- "This shift is already closed. Reloading…"
- "2 offline sales on this till are not synced yet…" — reconnect and wait for the bar to clear, then close.
- "Register T1 reported 3 unsynced sales at 14:02." — another device still holds sales for this till. Close only if
  you must, with a note saying why; they are added to the shift report as late sales when they arrive.
- "You don't have permission to close shifts."

## Selling offline

Only on a till the owner set up for it (you see **Offline ready · series T1** [جاهز للبيع دون اتصال] above the cart).
If the internet or the server drops, the till carries on:

- A red bar says **Offline — 2 sales waiting** [غير متصل]. Search, scan, discount and take cash, card or wallet as
  usual. No customers offline (walk-in only), no refunds, voids, pay-ins or closing.
- Each sale gets a number like **T1-000045** and its slip says **Offline sale** [بيع دون اتصال]. That is the sale's
  number for good, also on Returns.
- Reloading the page or restarting the browser is fine: the till and its waiting sales come back.
- When the connection is back the sales send themselves (within 30 seconds) and the bar clears. Leave the browser
  open until it does.
- The till stops selling offline after 12 hours without the server, at 300 waiting sales, or when your sign-in ends.
  It tells you why; reconnect to carry on.
- A sale in red ("Sale T1-000045 could not be saved — call a manager") stays on screen. Call a manager; do not clear
  the browser.
- **Close shift** waits until every offline sale has been sent.

## What isn't there

No automatic promotions or coupons. A shop linked to the inventory system cannot sell weighed items. Full list: [known limitations](../product/known-limitations.md).
