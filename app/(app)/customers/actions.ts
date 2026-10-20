"use server";
/**
 * Customer Server Actions: thin adapters over modules/customers (customers-spec §3). Every action is
 * a public POST, so each one re-resolves the tenant and relies on the service's permission checks.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { actionError, getRequestId } from "@/lib/http";
import {
  createCustomer,
  updateCustomer,
  type CustomerInput,
  type CustomerPatch,
  type CustomerRow,
} from "@/modules/customers";
import type { ActionResult } from "./_lib/customers";

async function run<T>(fn: (ctx: TenantContext, meta: { requestId: string }) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    const data = await fn(ctx, { requestId: getRequestId(h) });
    revalidatePath("/customers", "layout");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: await actionError(err, "customers") };
  }
}

/** Adds a customer: the back office, or the till's quick-add (customers.create). */
export async function createCustomerAction(input: z.input<typeof CustomerInput>): Promise<ActionResult<CustomerRow>> {
  return run((ctx, meta) => createCustomer(ctx, input, meta));
}

/** Edits, archives (`isActive: false`) or restores a customer (customers.manage). */
export async function updateCustomerAction(
  customerId: string,
  input: z.input<typeof CustomerPatch>,
): Promise<ActionResult<CustomerRow>> {
  return run((ctx, meta) => updateCustomer(ctx, customerId, input, meta));
}
