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
- Manager: inventory.*, sales.void, refunds, discounts.override, reports.view.
- Cashier: sales.create, registers.open/close (+ discounts.apply only if granted).
- Reporting: reports.view only.

Branch scoping enforced alongside role checks, server-side.
