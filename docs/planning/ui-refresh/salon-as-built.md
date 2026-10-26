# Salon (UI Refresh E): As Built

Built 2026-10-26 against [salon-spec.md](salon-spec.md) and [salon-plan.md](salon-plan.md), in three stacked PRs:
service items, staff and commission, and appointments.

## What exists

- **Service items** (migration `salon_services`): a product can be a service when created ("This is a service" on
  the product form), with a duration of 5-480 minutes (30 by default, editable). Services cannot be weighed or have
  variants. The stock ledger refuses a service in every stock write (`applyLines`, 422 `ITEM_NOT_STOCKED`), POs and
  direct receipts refuse them, and stock lists and counts leave them out. Sales, refunds and voids move stock only for
  the products on them.
- **Team** (migration `salon_staff`): Settings → Team (salon shops; Owner and Admin, audited) lists staff members with
  their branches and commission percent. They do not sign in.
- **Staff on lines**: the till's Staff selector sets who does new lines; each line can be changed. One item by two
  staff members is two lines. Lines keep the staff member's name and commission percent as at the sale. Receipts,
  refund screens and slips say "by Sara". Staff must be active and in the sale's branch (422 `STAFF_INVALID`); an
  offline replay takes them as they were.
- **Staff commission report** (salon shops): per staff member, lines, net after discounts and VAT, refunded net and
  commission at each line's percent, with CSV.
- **Appointments** (migration `salon_appointments`): Appointments in the nav for salon shops shows a day per branch,
  a column per staff member plus "Any", 15-minute rows within the opening hours (Settings → Shop, Owner, 09:00-21:00
  by default). An empty slot books (typed name and phone, services, note); a block opens Arrived, No-show, Cancel and
  Check out. A staff member's open appointments never overlap (409 `SLOT_TAKEN`, a per-staff lock); versions refuse
  stale changes. Check out opens the till with the services for the staff member and the customer; charging marks the
  appointment Done and links the sale (409 `APPOINTMENT_CLOSED` on a second checkout).

## Deviations from the plan

| Plan | As built | Why |
| ---- | -------- | --- |
| Settings → Staff members | Settings → Team (`/settings/team`) | Staff already manages user sign-ins |
| Overlap by a btree_gist exclusion constraint | A per-staff advisory lock and check | The extension is not assumed on every database |
| Staff in the offline snapshot | Staff from the server-rendered till page | As for scale settings in C; offline replay accepts any staff of the shop |
| Moving an appointment on the calendar | API only; cancel and book again on screen | Kept the calendar to tap-to-book |

## Tests

Unit: `appointment-slots.test.ts`, `sales-options.test.ts` (staff keys), `pos-till-helpers.test.ts` (staff
lines). Integration: `service-items.test.ts`, `staff-members.test.ts`, `sale-staff.test.ts` (lines, refusals,
commission with discount, refund and a changed percent), `appointments.test.ts`, `appointment-checkout.test.ts`.
E2E: `salon.spec.ts` (Team, booking, checkout with a product added, "by Sara", commission, Arabic; retail has no
Appointments).
