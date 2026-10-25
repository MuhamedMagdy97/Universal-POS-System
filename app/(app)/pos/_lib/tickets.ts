/**
 * Open tickets at the till (restaurant-cafe-spec R4, R5, R10), client-safe and pure. Unit-tested in
 * tests/unit/pos-tickets.test.ts.
 */
import type { ErrorBody } from "@/lib/errors";
import type { MessageKey } from "@/lib/i18n";
import type { TicketView } from "@/modules/sales/tickets";
import { saleErrorKey, type CartLine } from "./till";

/** A loaded ticket as cart lines: priced with their options, with how much went to the kitchen. */
export function cartFromTicket(ticket: Pick<TicketView, "lines">): CartLine[] {
  return ticket.lines.map((line) => ({
    ...line.item,
    qty: line.qty,
    unitPriceMinor: line.unitPriceMinor,
    ...(line.options.length > 0 && { options: line.options, optionLabels: line.optionLabels }),
    ...(line.note && { note: line.note }),
    sentQty: line.sentQty,
  }));
}

/** The cart as the ticket save takes it. */
export function ticketLinesOf(cart: readonly CartLine[]) {
  return cart
    .filter((line) => line.qty > 0)
    .map((line) => ({
      ref: { productId: line.productId, variantId: line.variantId },
      qty: line.qty,
      ...(line.options?.length ? { options: line.options } : {}),
      ...(line.note ? { note: line.note } : {}),
    }));
}

/** Whole minutes a ticket has been open, for the table tile. */
export function minutesOpen(openedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(openedAt).getTime()) / 60_000));
}

/** The message for a refused ticket action; anything else reads as a sale error. */
export function ticketErrorKey(error: ErrorBody): MessageKey {
  const reason = (error.details as { reason?: string } | null)?.reason;
  switch (reason) {
    case "TICKET_CHANGED":
      return "pos.ticket.error.changed";
    case "TICKET_CLOSED":
      return "pos.ticket.error.closed";
    case "TABLE_BUSY":
      return "pos.ticket.error.busy";
    case "CUSTOMER_REQUIRED":
      return "pos.ticket.error.customer";
    case "REASON_REQUIRED":
      return "pos.ticket.error.reason";
  }
  return error.code === "FORBIDDEN" ? "pos.ticket.error.forbidden" : saleErrorKey(error);
}
