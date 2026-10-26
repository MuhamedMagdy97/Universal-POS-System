"use server";
/**
 * Appointments Server Actions (salon-spec S5-S7): thin adapters over modules/appointments. Each re-resolves the
 * tenant; the service checks permission, branch, overlaps and version.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import type { ErrorBody } from "@/lib/errors";
import { actionError, getRequestId } from "@/lib/http";
import { bookAppointment, setAppointmentStatus, updateAppointment, type AppointmentView } from "@/modules/appointments";

export type AppointmentActionResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

async function run<T>(
  fn: (ctx: TenantContext, meta: { requestId: string }) => Promise<T>,
): Promise<AppointmentActionResult<T>> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    const data = await fn(ctx, { requestId: getRequestId(h) });
    revalidatePath("/appointments");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: await actionError(err, "appointments") };
  }
}

export async function bookAppointmentAction(input: unknown): Promise<AppointmentActionResult<AppointmentView>> {
  return run((ctx, meta) => bookAppointment(ctx, input, meta));
}

export async function updateAppointmentAction(
  id: string,
  input: unknown,
): Promise<AppointmentActionResult<AppointmentView>> {
  return run((ctx, meta) => updateAppointment(ctx, id, input, meta));
}

export async function setAppointmentStatusAction(
  id: string,
  input: unknown,
): Promise<AppointmentActionResult<AppointmentView>> {
  return run((ctx, meta) => setAppointmentStatus(ctx, id, input, meta));
}
