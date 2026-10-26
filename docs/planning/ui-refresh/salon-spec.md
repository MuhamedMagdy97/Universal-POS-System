# Salon (UI Refresh E): Specification

Status: **Approved by the owner (2026-10-25); built 2026-10-26 ([as built](salon-as-built.md)).** Every choice below is the recommended one.

Source: [overview](README.md), [business profiles as built](business-profiles-as-built.md),
[restaurant and café as built](restaurant-cafe-as-built.md). Today every product holds stock, a sale line has no staff
member, there is no booking and no commission. Salon shops already get tap tiles and say "Services", and options
(D) let a service carry extras such as "Long hair +50.00".

## 1. Goal

A barbershop or beauty salon sells services that hold no stock, records who did each service, books appointments
on a calendar per stylist and checks them out at the till, and pays commission from a report. Products for sale
(shampoo, wax) keep working as today.

## 2. Decisions

| #   | Question | Decision (recommended) |
| --- | -------- | ---------------------- |
| S1  | Who gets it | Service items work in any shop. Staff on lines, the calendar and the commission report show for the `SALON` profile only (a profile flag `appointments: true`). |
| S2  | Service items | A product can be a **service** (`Product.isService`, set when created, fixed after, like the unit). A service has a duration in minutes (5–480, default 30) and holds no stock: selling, refunding or voiding it moves no stock. Services do not appear in stock, counts, transfers, low stock, purchasing or the inventory-system sync, and cannot have variants or be sold by weight. They can have options (D). A shop linked to the inventory system gets its catalog from there, so it has no service items. |
| S3  | Staff members | The people who do the work are a list of their own (`StaffMember`: name, Arabic name, branches, commission percent 0–100 % in basis points, active), managed by Owner and Admin in Settings → Staff members and audited. A staff member does not need to sign in; one may be linked to a user. Leaving one out deactivates them; old sales keep their name. |
| S4  | Staff on a sale line | Each line can carry the staff member who did it (`SaleItem.staffMemberId` and a name snapshot). The till has a **Staff** selector: new lines take the selected staff member, and each line's staff member can be changed. It is optional; a line without staff earns no commission. Lines of one item done by different staff members stay separate lines (as with options in D). Refunds keep the line's staff member. |
| S5  | Appointments | An appointment (`Appointment`): branch, staff member (optional: "any"), customer (an existing one, or a name and phone typed in), the services booked, start time, end (start plus the services' durations), a note, and a status: **Booked**, **Arrived**, **Done**, **Cancelled** or **No-show**. One staff member cannot have two appointments that overlap (409 `SLOT_TAKEN`); "any" is not checked. Staff with `sales.create` book, move and change them; cancelling or marking no-show is audited. |
| S6  | The calendar | **Appointments** (a new page in the nav for salon shops) shows a day per branch: a column per active staff member plus "Any", 15-minute rows from the opening hour to closing (a shop setting, default 09:00–21:00), each appointment as a block with the customer, services and status. Pick a day, tap an empty slot to book, tap a block to open it. A list view below shows the day's appointments in order for small screens. |
| S7  | Checking out | **Check out** on an appointment opens the till with its services as lines, each for the appointment's staff member, and its customer. Charging the sale marks the appointment Done and links them (`Sale.appointmentId`). The cashier can add products or change lines before charging, as with any sale. |
| S8  | Commission | A **Staff commission** report (Reports, `reports.view`): per staff member and date range, the net revenue of their lines (after discounts, before VAT, less refunds of those lines) and commission = net × their percent. The percent is taken at the time of each sale (snapshot on the line, `SaleItem.commissionBp`), so a later change does not rewrite past pay. CSV export like other reports. Products sold by a staff member count too. |
| S9  | Offline | Staff members are in the till snapshot, so lines keep their staff offline. Appointments need the server; offline the till sells at the counter. |
| S10 | Receipts | A line shows its staff member's name under it ("by Sara"). |
| S11 | Migrations | Three, one per PR: (1) `Product.isService` and `durationMin`; (2) staff members, their branches, the line's staff member, name and commission snapshot; (3) appointments, their services, the sale's appointment link and the shop's opening hours. No backfill. |

## 3. Out of scope

Online booking by customers; SMS or WhatsApp reminders; deposits and pre-payment; staff working hours, breaks and
rotas; resources (chairs, rooms); packages and memberships; tips; commission rates per service; payroll; recurring
appointments; a waitlist.

## 4. Tests

- Unit: service items in stock rules (no movement lines), appointment end and overlap, calendar slots for a day,
  commission arithmetic (net after discount and refund, percent snapshot).
- Integration: a service sale moves no stock and a mixed sale moves only the product; refund and void of a service;
  service refused in stock, count, transfer and purchase lines; staff members CRUD (permission, audit); staff on a
  line, separate lines per staff member, staff on the refund; appointments booked, overlap refused for one staff
  member and allowed for "any", moved, cancelled, no-show; check out marks Done and links the sale; commission
  report with a discount, a refund and a changed percent; `expectReconciled` after each.
- E2E: a salon creates a 45-minute "Haircut" service and a staff member Sara at 40 %, books Mona at 10:00 with
  Sara, checks her out with a shampoo added, the receipt says "by Sara", the commission report shows Sara's net and
  commission; the calendar in Arabic RTL; a retail shop has no Appointments.

## 5. Delivery

Three PRs, merged in order:

1. Service items: the product flag and duration, no stock for services across sales, refunds, voids and the
   inventory and purchasing screens (migration 1).
2. Staff members, staff on sale lines (till selector, receipts, refunds, offline) and the commission report
   (migration 2).
3. Appointments: the calendar, booking and statuses, check out at the till, opening hours; docs and as-built note
   (migration 3).
