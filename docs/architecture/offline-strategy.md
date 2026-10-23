# Offline Strategy

## MVP decision (2026-10, superseded)
Online-only checkout: the server is the source of truth and the till blocks checkout when offline.

## Offline till (built 2026-10-22/23)
Opt-in per shop ("Allow offline sales", Owner, off by default) and per till (one enrolled browser per register). Spec:
[offline-till-spec](../planning/offline-till/offline-till-spec.md); as built: slices
[1](../planning/offline-till/slice1-as-built.md) (server), [2](../planning/offline-till/slice2-as-built.md) (till),
[3](../planning/offline-till/slice3-as-built.md) (service worker), [4](../planning/offline-till/slice4-as-built.md)
(close guard, drill) and the [review list](../planning/offline-till/slice4-review-as-built.md).

- **Sales only**, walk-in only; cash, card and wallet recorded by hand. No refunds, voids, cash movements, shift
  open/close or customers offline. Not for shops linked to the inventory system.
- The till keeps a snapshot (items, prices, settings, shift, user) and a queue in IndexedDB; a service worker keeps the
  till page so a reload offline still opens it. An offline sale is priced with the server's own `totals.ts`, numbered in
  the register's series (`T1-000045`), stored before its slip prints, and replayed oldest first with its
  Idempotency-Key.
- The server records an offline sale **as sold** and flags drift (price changed, item archived, stock negative,
  discount over limit, late for a closed shift, stale snapshot, clock skew, totals differ) for the
  "Offline sales to review" list. Hard refusals stay red on the till for a manager.
- Limits: snapshot ≤ 24 h to start, 12 h without the server, 300 queued, session expiry.
- A shift does not close over unsynced offline sales at its own till; a close elsewhere needs a note.
- Recovery: [failure-recovery drill 5](../operations/failure-recovery.md#5-offline-till-replay-through-a-crash).
