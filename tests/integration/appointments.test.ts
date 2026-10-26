import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import type { TenantContext } from "@/lib/auth/tenant";
import { bookAppointment, listDay, setAppointmentStatus, updateAppointment } from "@/modules/appointments";
import * as catalog from "@/modules/catalog";
import { saveStaffMember, type StaffMemberRow } from "@/modules/org";
import { createMember, createProduct, createTenant, expectAppError, testDb, uniqueCode } from "./helpers";

/**
 * Appointments (salon-spec S5, S6): Haircut 45 min and Beard 15 min; Sara works in the main branch. Days are in the
 * shop's time zone (Egypt). Each test uses its own day.
 */

let db: Db;
let orgId: string;
let branchId: string;
let otherBranchId: string;
let cashier: TenantContext;
let stranger: TenantContext;
let haircut: string;
let beard: string;
let shampoo: string;
let sara: StaffMemberRow;

const at = (day: string, startMin: number, extra: Record<string, unknown> = {}) => ({
  branchId,
  day,
  startMin,
  staffMemberId: sara.id,
  customerName: "Mona",
  customerPhone: "01001234567",
  serviceIds: [haircut],
  ...extra,
});

beforeAll(async () => {
  db = testDb();
  const tenant = await createTenant(db, "Bookings");
  orgId = tenant.org.id;
  branchId = tenant.branchA.id;
  otherBranchId = tenant.branchB.id;
  const owner = await createMember(db, orgId, "OWNER");
  cashier = await createMember(db, orgId, "CASHIER");
  stranger = await createMember(db, (await createTenant(db, "BookingsOther")).org.id, "OWNER");
  const service = async (name: string, minutes: number) =>
    (
      await catalog.createProductAggregate(owner, {
        sku: `S-${uniqueCode()}`,
        name,
        priceMinor: 10_000,
        isService: true,
        durationMin: minutes,
      })
    ).id;
  haircut = await service("Haircut", 45);
  beard = await service("Beard", 15);
  shampoo = (await createProduct(db, orgId)).id;
  sara = await saveStaffMember(owner, { name: "Sara", commissionBp: 4_000, branchIds: [branchId] });
});

afterAll(async () => {
  await db.$disconnect();
});

describe("booking", () => {
  it("books 10:00-10:45, refuses an overlap for Sara, allows Any and back to back", async () => {
    const first = await bookAppointment(cashier, at("2026-11-02", 600));
    expect(first).toMatchObject({ startMin: 600, endMin: 645, status: "BOOKED", staff: { name: "Sara" } });
    expect(first.customer).toEqual({ id: null, name: "Mona", phone: "01001234567" });

    await expectAppError(bookAppointment(cashier, at("2026-11-02", 630)), 409, "SLOT_TAKEN");
    await bookAppointment(cashier, at("2026-11-02", 630, { staffMemberId: null }));
    const next = await bookAppointment(cashier, at("2026-11-02", 645, { serviceIds: [haircut, beard] }));
    expect(next).toMatchObject({ startMin: 645, endMin: 705 });

    const day = await listDay(cashier, branchId, "2026-11-02");
    expect(day).toMatchObject({ opensAt: 540, closesAt: 1260 });
    expect(day.appointments.map((row) => [row.startMin, row.staff?.name ?? "Any"])).toEqual([
      [600, "Sara"],
      [630, "Any"],
      [645, "Sara"],
    ]);
  });

  it("moves, changes services, refuses a stale version, and frees the slot when cancelled", async () => {
    const booked = await bookAppointment(cashier, at("2026-11-03", 600));
    const other = await bookAppointment(cashier, at("2026-11-03", 720));
    await expectAppError(
      updateAppointment(cashier, other.id, { version: other.version, startMin: 615 }),
      409,
      "SLOT_TAKEN",
    );
    const moved = await updateAppointment(cashier, booked.id, { version: 1, startMin: 660, serviceIds: [beard] });
    expect(moved).toMatchObject({ startMin: 660, endMin: 675, version: 2 });
    await expectAppError(
      updateAppointment(cashier, booked.id, { version: 1, startMin: 540 }),
      409,
      "APPOINTMENT_CHANGED",
    );

    await setAppointmentStatus(cashier, other.id, { version: other.version, status: "CANCELLED" });
    await bookAppointment(cashier, at("2026-11-03", 720));
    const noShow = await setAppointmentStatus(cashier, moved.id, { version: moved.version, status: "NO_SHOW" });
    expect(noShow.status).toBe("NO_SHOW");
    expect(
      await db.auditEvent.count({ where: { orgId, action: { in: ["appointment.cancelled", "appointment.no_show"] } } }),
    ).toBe(2);
  });

  it("refuses a product that is not a service, no customer, staff from another branch, and other shops", async () => {
    await expectAppError(
      bookAppointment(cashier, at("2026-11-04", 600, { serviceIds: [shampoo] })),
      422,
      "NOT_A_SERVICE",
    );
    await expectAppError(
      bookAppointment(cashier, at("2026-11-04", 600, { customerName: undefined })),
      422,
      "CUSTOMER_REQUIRED",
    );
    await expectAppError(
      bookAppointment(cashier, at("2026-11-04", 600, { branchId: otherBranchId })),
      422,
      "STAFF_INVALID",
    );
    await expectAppError(listDay(stranger, branchId, "2026-11-04"), 404);
  });
});
