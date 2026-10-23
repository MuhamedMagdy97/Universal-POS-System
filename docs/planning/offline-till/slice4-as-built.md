# Offline till: slice 4 as built (close guard, drill, docs)

Spec: `offline-till-spec.md` (OF14, §3 drill, slice 4). The review list and the shift report's late sales are in
[slice4-review-as-built.md](slice4-review-as-built.md).

## What exists

- **Device report** (OF14): `RegisterDevice.reportedQueued`, `reportedOldestAt`, `reportedAt` (migration
  `20261023120000_offline_device_report`). The till reports `{ deviceId, secret, queued, oldestAt }` through
  `reportOfflineQueue` with every snapshot refresh and after a replay round that changed the count. Only the register's
  live device, with its secret, may report.
- **Close at the till**: **Close shift** checks the browser's own queue before any server call and refuses while any
  sale is waiting ("2 offline sales on this till are not synced yet…"); it checks again on submit.
- **Close elsewhere**: `closeShift` refuses with 409 `OFFLINE_SALES_UNSYNCED` (code, count, oldest, reported at) while
  the register's device last reported unsynced sales; the close screen shows "Register T1 reported 3 unsynced sales at
  14:02" and closes with the typed note (`CloseShiftInput.unsyncedNote`), kept in the `shift.closed` audit row. Those
  sales arrive later as late offline sales (review list, shift report).
- **Drill**: `node scripts/failure-drill.mjs offline` (50 queued, kill mid-replay, restart, replay all), recorded in
  [failure-recovery.md](../../operations/failure-recovery.md#5-offline-till-replay-through-a-crash). The drill's
  gap check now skips offline numbers.
- **Docs**: [offline-strategy.md](../../architecture/offline-strategy.md), cashier ("Selling offline"), owner ("Offline
  till"), manager ("Offline sales to review") guides, known limitations.

## Deviations from the spec

1. **Rejected entries do not block the close**: only sales still waiting do. A refused sale will never sync; it stays
   red on the till for a manager.
2. **Sign-out offline** (OF17) needs no guard of its own: signing out calls the server, so it cannot happen offline;
   queued sales replay under whoever signs in next and keep their offline cashier.
3. A device that drained its queue but could not report yet makes a close elsewhere ask for a note until its next
   report (at most one replay round once online).
