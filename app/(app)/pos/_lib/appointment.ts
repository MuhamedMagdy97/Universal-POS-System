import "server-only";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Locale } from "@/lib/i18n";
import { getAppointment } from "@/modules/appointments";
import { getSellableItems } from "@/modules/catalog";
import type { TillAppointment } from "./till";

/**
 * An open appointment to check out at the till (salon-spec S7): its services as items for its staff member, and its
 * customer when they are a known one. Null when it is not open or not in this branch.
 */
export async function appointmentForTill(
  ctx: TenantContext,
  id: string,
  branchId: string,
  locale: Locale,
): Promise<TillAppointment | null> {
  let appointment;
  try {
    appointment = await getAppointment(ctx, id);
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
  if (appointment.branchId !== branchId) return null;
  if (appointment.status !== "BOOKED" && appointment.status !== "ARRIVED") return null;
  let items;
  try {
    items = await getSellableItems(
      getDb(),
      ctx.orgId,
      appointment.services.map((service) => ({ productId: service.productId, variantId: null })),
    );
  } catch (err) {
    // A booked service archived since: the till opens empty, as without an appointment.
    if (err instanceof AppError) return null;
    throw err;
  }
  const customer = appointment.customer.id
    ? await getDb().customer.findFirst({
        where: { id: appointment.customer.id, orgId: ctx.orgId, isActive: true },
        select: { id: true, name: true, phone: true, taxNumber: true },
      })
    : null;
  return {
    id: appointment.id,
    items: items.map(({ costMinor: _cost, ...item }) => ({
      ...item,
      unitType: item.unitType === "KG" ? "KG" : "EACH",
    })),
    staff: appointment.staff
      ? { id: appointment.staff.id, name: (locale === "ar" && appointment.staff.nameAr) || appointment.staff.name }
      : null,
    customer,
    customerName: appointment.customer.name,
  };
}
