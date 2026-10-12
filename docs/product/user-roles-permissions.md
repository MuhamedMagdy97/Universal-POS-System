# User Roles & Permissions

## Roles (examples, not fixed IDs)
Owner (all), Admin, Branch manager, Cashier, Reporting.

## Permission model
Gate on action grants, never role-name string checks in business logic:

- products.read/create/update, inventory.adjust/transfer
- sales.create/void/refund, discounts.apply/override
- registers.open/close, purchases.receive
- reports.view, users.manage, settings.manage

## Matrix (MVP default)
- Owner: all.
- Admin: users.manage, settings.manage, products.*, inventory.*, purchases.*, reports.view.
- Manager: products.read, inventory.* (read included), sales.create, registers.open/close, sales.void, refunds,
  discounts.override, reports.view. Managers can work a till so they can cover a register and refund at it
  (owner decision 2026-10-12, T8 follow-up).
- Cashier: products.read, sales.create, registers.open/close (+ discounts.apply only if granted).
- Reporting: reports.view, inventory.read (read-only stock; D5).

Branch scoping enforced alongside role checks, server-side.

## Catalog notes (Phase 6, `lib/auth/permissions.ts`)
- Manager and Cashier have `products.read` so they can search and scan at the POS (decision Q1). Cost fields are
  hidden from them: `costMinor` needs `products.update`.
- Catalog writes need `products.create` (create product/variant/category, add barcode) or `products.update` (edit,
  price change, archive/restore, remove barcode). Denied write attempts are audit-logged (`catalog.permission.denied`).
