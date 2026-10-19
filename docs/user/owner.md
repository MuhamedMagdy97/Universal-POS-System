# Owner and admin guide

For the shop owner and admins: setting up the shop, staff, branches, tills, products, stock, purchasing, receipts,
reports and the audit trail. Arabic labels are in brackets.

**Owner vs admin.** An owner can do everything, including selling and refunds. An admin manages staff, settings,
catalog, stock, purchasing and reports but cannot use the till or Returns, and can only add or change managers,
cashiers and reporting users (not owners or admins). An owner who also sells: see the [cashier guide](cashier.md) and
the Returns part of the [manager guide](manager.md).

## 1. Set up the shop (once)

1. On the welcome page press **Set up a new business**.
2. **Type of business:** only **General retail** can be chosen; the others say "Coming soon".
3. **Shop name**, **Country** (Egypt or Saudi Arabia). This fixes the currency and VAT: EGP and 14% for Egypt, SAR and
   15% for Saudi Arabia. **They cannot be changed later.**
4. **First branch name** (default "Main"). A till named "Till 1" is added to it.
5. **Your owner account:** your name, email, a password of at least 10 characters, typed twice.
6. Press **Create shop** [إنشاء المتجر]. You are signed in on the Dashboard.

Refusals: "An account with this email already exists.", "The two passwords do not match.", "Your account already
belongs to a shop." (one login belongs to one shop).

Suggested order after setup: receipt settings → branches and tills → staff → categories and products → opening stock →
first sale.

## 2. Receipt settings

**Settings** [الإعدادات] → **Receipt** [الإيصال]. Fill in what should print on every receipt: legal name (defaults to
the shop name), **VAT number**, address, phone, a header line and a footer line. Leave a field empty to leave it off.
Press **Save** [حفظ]. Reprints of old sales pick up the current settings. Receipts are customer slips, not ZATCA or Egypt
e-receipts.

## 3. Branches and tills

**Settings** → **Branches and tills** [الفروع ونقاط البيع].

- **Add branch** [إضافة فرع]: name and a short code (A–Z, 0–9, -).
- **Add till** [إضافة صندوق] under a branch: a name, unique in that branch.
- **Rename**, **Deactivate** [إيقاف], **Reactivate** [إعادة تفعيل] for both.

Refusals: "This branch still has stock. Move it or write it off first.", "A shift is open at this branch. Close it
first.", "This till has an open shift. Close it first.", "The shop needs at least one active branch.", "Another branch
already uses this code.", "This branch already has a till with this name."

## 4. Staff

**Settings** → **Staff** [الموظفون] → **Add staff** [إضافة موظف].

1. Name, email, a temporary password (at least 10 characters).
2. **Role:** Owner, Admin, Manager, Cashier or Reporting. What each can do: [README](README.md#what-each-role-can-open).
3. **Branches:** **All branches** or **Chosen branches** (pick at least one). People only see and act on their branches.
4. Press **Add staff**. Give them the email and password yourself; there is no invite email and no forced password
   change. Ask them to change it under **My account**.

On a row: **Edit** (role and branches), **New password** [كلمة مرور جديدة] (signs them out everywhere),
**Deactivate** [إيقاف] (signs them out everywhere; they lose access to the shop) and **Reactivate**.

Refusals: "The shop needs at least one active owner.", "You cannot change your own access here. Use My account for
your password.", "Pick at least one branch.", "You are not allowed to do this." (an admin trying to manage an owner or
admin).

## 5. Catalog

**Catalog** [الكتالوج] → **Products** / **Categories**.

- **Categories:** **Add category** [إضافة تصنيف], optionally under a parent, up to 3 levels. **Rename**, archive.
  "Archive the active sub-categories first."
- **Add product** [إضافة منتج]: Name (English), Name (Arabic), SKU, Category, Unit (only **Each** works), Price,
  Cost, VAT category (Standard, Zero-rated, Exempt). Add **Barcodes** (scan or type, press **Add**; one is
  **Primary**). Press **Save** [حفظ] (Ctrl+S).
- **Variants:** **Add variant** [إضافة نوع] for sizes or colours, each with its own SKU, barcodes and optional price or
  cost (blank = the product's). A product with variants sells by variant: barcodes go on the variants.
- **Price changes** apply to new sales only; past sales keep their price.
- **Archive** [أرشفة] hides a product from the till and search; past sales and reports keep it. **Restore**
  [استعادة] brings it back.

Fill in **Cost**: profit reports use the cost at the moment of sale. Managers and cashiers can view products but not
change them, and never see cost.

Refusals: "SKU already used by {product}", "Barcode already assigned to {product}", "This unit is not supported yet",
"This product has variants: add barcodes to a variant instead", "Someone else changed this product. Reload to see the
latest version.", "Enter an amount like 12.50". "The price is below the cost. You can still save." is a warning only.

## 6. Inventory

Same screens as the [manager guide § Stock](manager.md#stock): opening stock per branch, adjust, transfer, history.
Start each branch with **Opening stock** [الرصيد الافتتاحي]. By default the till refuses to sell more than is on hand
("Not enough stock: …").

## 7. Purchasing

**Purchasing** [المشتريات].

1. **Suppliers** [الموردون] → **Add supplier**: name, phone, email, tax number. **Edit**, **Archive**, **Restore**.
2. **New purchase order** [أمر شراء جديد]: choose supplier and branch, add items (search by name, SKU or barcode),
   quantity and unit cost per line. Press **Create draft** [إنشاء مسودة].
3. **Mark as ordered** [تأكيد الطلب] when you send it to the supplier. **Print order** [طباعة أمر الشراء] gives a
   paper copy. You can still edit it until goods arrive.
4. When goods arrive, you or a manager press **Receive goods** [استلام البضاعة] (steps in the
   [manager guide](manager.md#receive-a-delivery)). The cost entered on receipt becomes the product's cost.
5. **Cancel order** [إلغاء الأمر] if nothing was received; **Close short** [إغلاق بالنقص] to drop units that will
   never come.

Refusals: "This order can no longer be edited.", "This supplier is archived.", "A supplier with this name already
exists.", "Enter a quantity of at least 1 and a valid cost on every line."

## 8. Reports, including profit

**Reports** [التقارير] works as in the [manager guide § Reports](manager.md#reports). Owners and admins also get:

- **Purchases received:** receipts, units and purchase value by supplier.
- **Profit by product**, **Profit by category**, **Profit by day:** net revenue ex VAT, cost, gross profit and
  margin. Items sold without a cost are shown under "Revenue without cost" / "Lines without cost" and left out of
  profit ("Some items were sold without a cost…"). Add the cost in the catalog to fix future sales; past sales keep
  the cost they had.

## 9. Audit trail

**Audit trail** [سجل التدقيق] lists who did what: sales, voids, refunds, shifts, cash in and out, stock changes, price
changes, staff and settings changes, reprints and exports. Filter by dates, **Who**, **Action** (choose **Denied
attempts** to see refused actions) and **Record type**, then **Show** [عرض]. **Show** on a row opens its details. **Older
events** pages back; **Export CSV** downloads the list. Exports are themselves logged.

## 10. Your own account

**My account** [حسابي] → **Change password**. Nobody can reset a forgotten owner password by email; keep a second
owner if you can.

What isn't built (no ZATCA/e-receipts, no discounts, no customer records, no billing or shop deletion, country and
currency fixed): [known limitations](../product/known-limitations.md).
