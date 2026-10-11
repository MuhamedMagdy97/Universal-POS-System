# System Architecture

## Choice
Modular monolith: Next.js App Router (TypeScript) + PostgreSQL + Prisma.
One deployable. No microservices, broker, or K8s in MVP.

## Structure
`app/` routes → `modules/<domain>/` service → Prisma → Postgres,
one DB transaction per workflow (sale, receive, close-shift).

## Modules
auth, org (tenant/branch/register/membership), catalog, inventory (ledger),
sales, payments (manual + provider boundary), registers, purchasing,
reports, audit, presets (business-type config only).

## Seam rule
No cross-module direct table writes (e.g. sales calls
`inventory.recordSale()`). Presets write config only, never fork logic.
