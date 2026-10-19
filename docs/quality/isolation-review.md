# Tenant and permission isolation review

Reviewed 2026-10-19 on `main` at `0b6ded5`, against [user-roles-permissions](../product/user-roles-permissions.md) and
`lib/auth/permissions.ts`. Covers every Route Handler under `app/api/`, every Server Action file
(`app/(app)/**/actions.ts`, `_lib/receipt-action.ts`, `(public)/onboarding/actions.ts`), the page contexts that read
the database directly, and the exported service functions they call.

## How the guard works

- Every tenant route and action starts with `requireTenant` (`lib/auth/tenant.ts`): the org comes from the server
  session, an inactive membership is refused, and a client-supplied branch is honoured only when it is an active branch
  of that org inside the membership's scope (else 404).
- Write permissions are checked in the service, not the route, so a refusal is audit-logged
  (`*.permission.denied`). Reads pass `permission` to `apiRoute` or check it in the service.
- Rows loaded by id are always filtered by `orgId`; another tenant's id answers 404 like a missing one.
- Branch scope is checked in the service for every branch-bound operation: stock reads and writes, sales, refunds,
  voids, receipts, shifts and cash movements (`requireBranch` / `requireShiftInScope` / `requireSaleInScope`),
  purchase orders (`lockPo`, `branchIdsInScope`), reports (`resolveBranchIds`).

## Matrix check

| Area | Entry points | Permission (service) | Branch scope |
| --- | --- | --- | --- |
| Catalog reads | `GET /api/products`, `/categories`, `/barcodes`, `/catalog/search` | `products.read`; cost needs `products.update` | n/a (org-wide) |
| Catalog writes | product, variant, category, barcode create/update/archive/restore; catalog actions | `products.create` / `products.update` | n/a |
| Inventory reads | `GET /api/inventory/stock`, `/ledger`; inventory pages | `inventory.read` | yes |
| Inventory writes | adjust, opening, transfer; inventory actions | `inventory.adjust` / `inventory.transfer` | source yes; destination any active branch (D6) |
| Sales | `POST /api/sales`; `createSaleAction` | `sales.create` | branch + register |
| Refunds / voids | `/api/sales/{id}/refunds`, `/void`; returns actions | `sales.refund` / `sales.void` | sale's branch |
| Receipts | `/api/sales/{id}/receipt`; `receiptAction` | refund or void right, or the sale's own cashier | sale's branch |
| Shifts | open, close, cash movements, Z-report | `registers.open` / `registers.close`; pay-in `sales.create` | shift's branch |
| Purchasing | suppliers, POs, transitions, receiving; purchasing actions | `purchases.manage`; receive `purchases.receive`; view either | PO's branch |
| Reports | `/api/reports/{report}`, dashboard tiles | `reports.view`; purchases + `purchases.manage`; profit + `products.update` | requested or all in scope |
| Audit trail | `/api/audit` | `users.manage` (Owner, Admin) | org-wide |
| Settings | receipt settings, branches, tills | `settings.manage` | org-wide |
| Staff | staff actions | `users.manage`; only an Owner manages Owners and Admins; no self-edit; last Owner kept | org-wide |
| Account | password change | own user only | n/a |
| Onboarding | `createShopAction` | signed-in user with no shop | creates the tenant |

Each row matches the matrix in user-roles-permissions.md. Automated coverage for the rows is in
`tests/integration/*-isolation*.test.ts`, `tenant-guard.test.ts`, the "scope and isolation" blocks of the module
tests, and the E2E access specs.

## Findings

1. **Fixed: receiving replayed outside branch scope.** `receivePurchaseOrder` looked up a stored receipt by
   Idempotency-Key before checking the PO's branch, so a branch-limited Manager holding another branch's key and body
   got that receipt and PO back (200) instead of 404. Sales and refunds already checked scope first. The service now
   checks the PO's branch before the replay (`modules/purchasing/receipts.ts`); test "does not replay another
   branch's receipt to a branch-limited manager" in `tests/integration/purchasing.test.ts`. Exposure was low: the key
   is a random UUID only the original client knows.
2. **By design, noted:** any user with `registers.close` in the branch can close a shift another cashier opened, and
   a transfer may target any active branch of the shop (D6). Managers see PO unit costs because they receive against
   them (T5 P1).

No other gaps found.
