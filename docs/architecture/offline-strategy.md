# Offline Strategy

## MVP decision (locked)
Online-only checkout. Server is source of truth. UI blocks checkout when
offline and preserves cart contents. No queue/sync/conflict infrastructure.

## If offline is ever required later
Cached catalog, local persistence, queued transactions, idempotent sync,
conflict detection, terminal/transaction IDs, restart recovery, offline
payment restrictions, reconciliation — as a deliberate, separately tested phase.
No offline reliability claims until then.
