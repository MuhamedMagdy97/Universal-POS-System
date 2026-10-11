# API Contracts

- Auth: session; `orgId` derived server-side, never client-supplied.
- Errors: `{code, message, details}` → 401/403/404/409/422.
- Idempotency-Key header on `POST /api/sales` (and receive/refund paths).
- Cursor pagination on lists and reports.
- Endpoints: `/api/sales` (create, void, history), `/api/refunds`,
  `/api/products|categories|barcodes`, `/api/inventory/{adjust,transfer}`,
  `/api/purchasing/{pos,receive}`, `/api/shifts/{open,close}` + cash movements,
  `/api/reports/*`. Full contract table: Phase 4 report.
