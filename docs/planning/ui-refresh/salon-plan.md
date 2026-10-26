# Salon (UI Refresh E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (owner chose inline execution, PRs
> merged in order). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A salon sells services that hold no stock, records who did each line, books appointments per stylist and
checks them out at the till, and reads a commission report.

**Architecture:** `Product.isService` is refused at the stock ledger (`applyLines`), so every stock write rejects a
service. Sales, refunds and voids drop service lines before moving stock. Staff members are an org list referenced by
sale lines, with a name and commission snapshot. Appointments are a new `modules/appointments` module; checking one
out is an ordinary `createSale` with an `appointmentId`.

**Tech Stack:** Next.js 16 App Router (Server Actions, Cache Components), Prisma 7 on PostgreSQL 16, zod 4, Vitest,
Playwright, EN/AR RTL.

**Spec:** [salon-spec.md](salon-spec.md) (S1–S11).

## Global Constraints

- Staff on lines, the calendar and the commission report show for the `SALON` profile only (preset flag
  `appointments: true`; every other preset `false`). Service items work in any built-in shop (S1, S2).
- Three migrations, one per PR, `--create-only` and trimmed (never drop `POItem_one_line_per_item` or
  `Ticket_one_open_per_table`). No backfill.
- A service's `durationMin` is 5–480, default 30. Commission is 0–10,000 bp. Calendar rows are 15 minutes; the
  opening hours default to 09:00–21:00.
- `isService` and `unitType` are fixed after create. A service cannot be KG, cannot have variants, and cannot be
  created in a linked shop.
- Money stays integer minor units. Commission is `round(net × bp ÷ 10,000)` half up per line, summed per staff
  member.
- Every existing test stays green. Non-salon shops see no change except the optional "This is a service" box on the
  product form.

## Review Focus

- A sale with a haircut and a shampoo: only the shampoo moves stock, and refunding both moves only the shampoo back.
  Test: Task 1 integration.
- Two appointments for Sara at 10:00–10:45 and 10:30: the second is refused; "Any" at 10:30 is allowed; Sara at
  10:45 is allowed. Test: Task 5 unit and integration.
- A line discounted 10 % and later half refunded: commission is on what is left, at the percent at the time of sale
  even after Sara's percent changes. Test: Task 4 integration.
- Checking out an appointment twice (two tills) never sells it twice: the second is 409. Test: Task 6 integration.
- A retail shop: no Appointments, no Staff selector, receipts unchanged. Test: Task 6 E2E.

---

## PR 1: service items (branch `ui-refresh/salon-services`)

### Task 1: services hold no stock (migration 1)

**Files:**
- `prisma/schema.prisma`: `Product.isService Boolean @default(false)` and `Product.durationMin Int?`; migration
  `salon_services` with a CHECK of `durationMin` 5–480 when not null.
- `modules/catalog/schemas.ts`:
  - `CreateProduct` gains `isService` (default false) and `durationMin`;
  - `refineAggregate` refuses a service that is KG or has variants (`SERVICE_NOT_SUPPORTED` at `["isService"]`);
  - `SellableItem` carries `isService` and `durationMin`.
- `modules/catalog/aggregate.ts` (create only; update refuses a change with `UNIT_IMMUTABLE`) and the seam selects.
  Product summary and detail carry both fields.
- `modules/inventory/ledger.ts`: `applyLines` refuses a service with 422 `ITEM_NOT_STOCKED`.
- `stock.ts`, `reorder.ts`, the count sheet and purchasing PO lines leave services out or refuse them
  (`ITEM_NOT_STOCKED`).
- `modules/sales/create.ts`, `refunds.ts` (refund and void): `stockLinesOf` input skips service lines.
- Product form: a "This is a service" check box (create only) and a "Duration (minutes)" field. The product list
  shows a "Service" badge. i18n `catalog.service.*`.

Tests:
- integration `service-items.test.ts`:
  - haircut and shampoo sale: only the shampoo moves stock;
  - refund and void of both;
  - adjust, count, transfer, opening and PO with a service are refused;
  - a KG or variant service is refused;
  - stock list and low stock leave it out;
  - `expectReconciled`;
- unit `catalog-validation.test.ts`: the service refusals.

Then the full gate. PR 1.

---

## PR 2: staff and commission (branch `ui-refresh/salon-staff`)

### Task 2: staff members (migration 2)

**Files:**
- `prisma/schema.prisma`:
  - `StaffMember` (orgId, name, nameAr?, commissionBp Int 0–10000, userId?, isActive, sortOrder);
  - `StaffMemberBranch` (staffMemberId, branchId);
  - `SaleItem.staffMemberId?`, `SaleItem.staffName?` and `SaleItem.commissionBp?`.
- Migration `salon_staff`.
- `modules/org/staff-members.ts`: `listStaffMembers(ctx, branchId?)` (active, for the till; any member) and
  `saveStaffMember(ctx, input)` (create or update by id; `settings.manage`, audited `settings.staff_member.saved`).
- Settings → Staff members page (salon only). Preset flag `appointments`.

Tests: integration `staff-members.test.ts`: create, update the percent, deactivate, branch filter, a cashier denied.

### Task 3: staff on sale lines

**Files:**
- `modules/sales/schemas.ts`: `SaleLineInput.staffMemberId?: Uuid`.
- `create.ts`:
  - the merge key adds the staff member (`lineKeyOf(ref, options, note, staffMemberId)`);
  - a staff member must be active and in the sale's branch, else 422 `STAFF_INVALID`;
  - store `staffMemberId`, `staffName` and `commissionBp` (the snapshot);
  - `loadSale` lines gain `staff: { id; name } | null`.
- Receipts print "by Sara" (`receipt.by`). The refund view shows the staff member.
- Snapshot `staff: { id; name; nameAr }[]`.
- Till: a Staff selector beside the scan box (salon shops). New lines take it; a line's staff member is chosen from a
  small select on the line. Cart key adds the staff member. Offline carries it.

Tests:
- unit `sales-options.test.ts`: `lineKeyOf` with staff;
- unit `pos-till-helpers.test.ts`: lines split by staff;
- integration `sale-staff.test.ts`: two haircuts by two staff members are two lines; an inactive or other-branch
  staff member is refused; a refund keeps the staff member; offline replay.

### Task 4: the commission report

**Files:**
- `modules/reports/queries.ts`: `staffCommission(scope)` gives a row per staff member: `staffMemberId`, `name`,
  `nameAr`, `lines`, `netMinor`, `refundedNetMinor`, `commissionMinor`.
  - Net per line is `lineTotalMinor − vatMinor`; refunds are `amountMinor − vatMinor` of their refund items.
  - Commission per line is `round((net − refunded net) × commissionBp ÷ 10,000)`.
  - Lines with no staff member are left out.
- `columns.ts`: report `staff-commission` (money columns, totals).
- The report is listed for salon shops only (others can still open it by URL; it is empty).
- i18n `reports.staffCommission.*`.

Tests: integration in `sale-staff.test.ts`:
- Sara at 40 %: a 100.00 haircut discounted 10 % with VAT included at 14 % has net 78.95 and commission 31.58;
- a half refund halves both;
- a percent change after the sale does not move past commission;
- the CSV has the row.

Then the full gate. PR 2.

---

## PR 3: appointments (branch `ui-refresh/salon-appointments`)

### Task 5: appointments (migration 3)

**Files:**
- `prisma/schema.prisma`:
  - `Appointment` (orgId, branchId, staffMemberId?, customerId?, customerName?, customerPhone?, startsAt, endsAt,
    status `AppointmentStatus` BOOKED/ARRIVED/DONE/CANCELLED/NO_SHOW, note?, saleId?, createdById, version);
  - `AppointmentService` (appointmentId, productId, sortOrder);
  - `Sale.appointmentId?`;
  - `Organization.opensAt Int @default(540)` and `closesAt Int @default(1260)` (minutes after midnight).
- Migration `salon_appointments`, with an exclusion constraint so a staff member's BOOKED or ARRIVED appointments
  cannot overlap (`btree_gist`, `tstzrange(startsAt, endsAt)`), or a lock and check if the extension is not
  available.
- `modules/appointments/`:
  - `bookAppointment(ctx, input)`: the end is the start plus the services' durations; refused when a service is not
    a service (422 `NOT_A_SERVICE`), or an existing customer or a name and phone is missing;
  - `updateAppointment(ctx, id, { version, ...changes })` to move, change staff or services;
  - `setAppointmentStatus(ctx, id, { version, status })` (audited for CANCELLED and NO_SHOW);
  - `listDay(ctx, branchId, day)` in the shop's time zone;
  - 409 `SLOT_TAKEN` when a staff member's appointments would overlap; 409 `APPOINTMENT_CHANGED` on a stale
    version.
- Pure `modules/appointments/slots.ts`: `daySlots(opensAt, closesAt)` and `overlaps(a, b)`.

Tests:
- unit `appointment-slots.test.ts`: slots 09:00–21:00 make 48 rows, plus the overlap edges;
- integration `appointments.test.ts`:
  - book, then a second booking that overlaps for Sara is refused;
  - the same slot is allowed for "Any", and a back-to-back booking is allowed;
  - move and change services;
  - cancel and no-show;
  - a stale version;
  - another branch is refused.

### Task 6: the calendar and checking out

**Files:**
- `app/(app)/appointments/page.tsx` and `_components/day-calendar.tsx`: a day picker, one column per staff member
  plus "Any", 15-minute rows, blocks, a list view below, and a booking dialog (customer search or name and phone,
  services, staff, time).
- The nav link "Appointments" shows for salon shops.
- `SaleInput.appointmentId?`. `create.ts` locks the appointment (BOOKED or ARRIVED, the same branch), marks it DONE
  with `saleId` in the same transaction, and a second checkout is 409 `APPOINTMENT_CLOSED`.
- Till: `/pos?appointment=<id>` loads its services (with its staff member) and its customer into the cart.
- Settings → Shop: opening hours (salon only).
- Docs: cashier guide (services, staff, appointments, commission), known limitations (spec §3), the as-built note,
  phase status and the README row.

Tests:
- integration `appointment-checkout.test.ts`: checkout marks DONE and links the sale; a second checkout gets 409;
  adding a product at checkout;
- E2E `salon.spec.ts`: Haircut 45 min, Sara 40 %, Mona booked at 10:00, checked out with a shampoo, the receipt says
  "by Sara", commission shows; Arabic; retail has no Appointments.

### Task 7: verification

- [ ] Full gate. Final whole-branch review on opus; fix pass. Open the PRs with auto-merge and confirm CI is green.
