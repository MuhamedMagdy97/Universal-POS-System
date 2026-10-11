# User Flows

## J1 — Sell (primary)
Open shift → search/scan → cart → discount (if permitted) → pay (split) →
receipt → stock deducted. Offline attempt blocked with cart preserved.

## J2 — Return
From original sale → select lines/qty → reason → refund method →
compensating movement + audit.

## J3 — Stock in
Create PO → receive (full/partial) → on-hand + ledger updated.

## J4 — Close shift
Expected auto-computed → counted entry → discrepancy note required if ≠ 0 →
shift locked.

## States (every journey)
Loading (skeleton/spinner), error (inline + retry), empty (CTA),
success (toast + receipt). See Phase 2 report for screen inventory.
