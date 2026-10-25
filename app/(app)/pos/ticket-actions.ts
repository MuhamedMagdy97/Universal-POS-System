"use server";
/**
 * Open tickets at the till (restaurant-cafe-spec R4-R6, R10): thin adapters over modules/sales. Each action
 * re-resolves the tenant; the service checks permission, branch and ticket version.
 */
import { headers } from "next/headers";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import type { ErrorBody } from "@/lib/errors";
import { actionError, getRequestId } from "@/lib/http";
import { listTables, type DiningTableRow } from "@/modules/org";
import {
  cancelTicket,
  getTicket,
  listOpenTickets,
  moveTicket,
  openTicket,
  saveTicketLines,
  sendToKitchen,
  type KitchenSlip,
  type TicketSummary,
  type TicketView,
} from "@/modules/sales";

export type TicketActionResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

async function run<T>(
  fn: (ctx: TenantContext, meta: { requestId: string }) => Promise<T>,
): Promise<TicketActionResult<T>> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    return { ok: true, data: await fn(ctx, { requestId: getRequestId(h) }) };
  } catch (err) {
    return { ok: false, error: await actionError(err, "pos") };
  }
}

/** The floor: the branch's active tables and its open tickets. */
export async function floorAction(
  branchId: string,
): Promise<TicketActionResult<{ tables: DiningTableRow[]; tickets: TicketSummary[] }>> {
  return run(async (ctx) => {
    const tickets = await listOpenTickets(ctx, branchId);
    const tables = (await listTables(ctx, branchId)).filter((table) => table.isActive);
    return { tables, tickets };
  });
}

export async function openTicketAction(input: unknown): Promise<TicketActionResult<TicketView>> {
  return run((ctx, meta) => openTicket(ctx, input, meta));
}

export async function getTicketAction(id: string): Promise<TicketActionResult<TicketView>> {
  return run((ctx) => getTicket(ctx, id));
}

export async function saveTicketAction(
  id: string,
  input: unknown,
): Promise<TicketActionResult<{ ticket: TicketView; cancelled: KitchenSlip | null }>> {
  return run((ctx, meta) => saveTicketLines(ctx, id, input, meta));
}

export async function sendTicketAction(
  id: string,
  version: number,
): Promise<TicketActionResult<{ ticket: TicketView; slip: KitchenSlip | null }>> {
  return run((ctx, meta) => sendToKitchen(ctx, id, version, meta));
}

export async function moveTicketAction(id: string, input: unknown): Promise<TicketActionResult<TicketView>> {
  return run((ctx, meta) => moveTicket(ctx, id, input, meta));
}

export async function cancelTicketAction(id: string, input: unknown): Promise<TicketActionResult<TicketView>> {
  return run((ctx, meta) => cancelTicket(ctx, id, input, meta));
}
