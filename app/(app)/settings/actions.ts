"use server";
/**
 * Settings Server Actions: receipt (T10 H3), staff, branches and tills (onboarding), and the inventory-system
 * link (Phase 13), offline till. Thin adapters over modules/org and modules/integrations/inventory-sys.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import type { ErrorBody } from "@/lib/errors";
import { actionError, getRequestId } from "@/lib/http";
import {
  addStaff,
  createBranch,
  createRegister,
  updateBranch,
  revokeOfflineDevice,
  updateBusinessType,
  updateOfflineSettings,
  updateReceiptSettings,
  updateRegister,
  updateScaleSettings,
  updateServiceCharge,
  saveTables,
  type DiningTableRow,
  updateStaff,
  type ReceiptSettings,
  type ReceiptSettingsInput,
} from "@/modules/org";
import {
  checkInventoryLink,
  mapInventoryBranches,
  retryInventoryPosting,
  saveInventoryLink,
  setInventorySource,
  syncInventoryNow,
  type CheckResult,
  type SyncSummary,
} from "@/modules/integrations/inventory-sys";
import type {
  BranchInput,
  BranchPatch,
  RegisterInput,
  RegisterPatch,
  StaffInput,
  StaffPatch,
} from "@/modules/org/schemas";

export type SettingsActionResult = { ok: true; data: ReceiptSettings } | { ok: false; error: ErrorBody };

export async function saveReceiptSettingsAction(
  input: z.input<typeof ReceiptSettingsInput>,
): Promise<SettingsActionResult> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    const data = await updateReceiptSettings(ctx, input, { requestId: getRequestId(h) });
    revalidatePath("/settings/receipt");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: await actionError(err, "settings") };
  }
}

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

/** Staff, branch and till actions (onboarding O3–O5): each re-resolves the tenant; the service checks the permission. */
async function run<T>(
  path: string,
  fn: (ctx: TenantContext, meta: { requestId: string }) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const h = await headers();
    const ctx = await requireTenant(h);
    const data = await fn(ctx, { requestId: getRequestId(h) });
    revalidatePath(path);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: await actionError(err, "settings") };
  }
}

export async function addStaffAction(input: z.input<typeof StaffInput>): Promise<ActionResult<null>> {
  return run("/settings/staff", async (ctx, meta) => {
    await addStaff(ctx, input, meta);
    return null;
  });
}

export async function updateStaffAction(
  membershipId: string,
  patch: z.input<typeof StaffPatch>,
): Promise<ActionResult<null>> {
  return run("/settings/staff", async (ctx, meta) => {
    await updateStaff(ctx, membershipId, patch, meta);
    return null;
  });
}

export async function createBranchAction(input: z.input<typeof BranchInput>): Promise<ActionResult<null>> {
  return run("/settings/branches", async (ctx, meta) => {
    await createBranch(ctx, input, meta);
    return null;
  });
}

export async function updateBranchAction(
  branchId: string,
  patch: z.input<typeof BranchPatch>,
): Promise<ActionResult<null>> {
  return run("/settings/branches", async (ctx, meta) => {
    await updateBranch(ctx, branchId, patch, meta);
    return null;
  });
}

export async function createRegisterAction(input: z.input<typeof RegisterInput>): Promise<ActionResult<null>> {
  return run("/settings/branches", async (ctx, meta) => {
    await createRegister(ctx, input, meta);
    return null;
  });
}

export async function updateRegisterAction(
  registerId: string,
  patch: z.input<typeof RegisterPatch>,
): Promise<ActionResult<null>> {
  return run("/settings/branches", async (ctx, meta) => {
    await updateRegister(ctx, registerId, patch, meta);
    return null;
  });
}

/** Inventory system (Phase 13 slice 1). The API key goes in, never comes back out. */
export async function saveInventoryLinkAction(input: {
  baseUrl: string;
  apiKey?: string;
}): Promise<ActionResult<CheckResult>> {
  return run("/settings/inventory", (ctx, meta) => saveInventoryLink(ctx, input, meta));
}

export async function checkInventoryLinkAction(): Promise<ActionResult<CheckResult>> {
  return run("/settings/inventory", (ctx, meta) => checkInventoryLink(ctx, meta));
}

export async function setInventorySourceAction(
  source: "BUILT_IN" | "EXTERNAL",
): Promise<ActionResult<{ syncError: string | null }>> {
  return run("/settings/inventory", async (ctx, meta) => ({
    syncError: (await setInventorySource(ctx, { source }, meta)).syncError,
  }));
}

/** Branch → inventory-system warehouse (Phase 13 slice 2, I5). */
export async function mapInventoryBranchesAction(
  map: { branchId: string; warehouseId: string | null }[],
): Promise<ActionResult<null>> {
  return run("/settings/inventory", async (ctx, meta) => {
    await mapInventoryBranches(ctx, { map }, meta);
    return null;
  });
}

export async function syncInventoryAction(): Promise<ActionResult<SyncSummary>> {
  return run("/settings/inventory", (ctx, meta) => syncInventoryNow(ctx, meta));
}

/** Retry one inventory-system posting (Phase 13 slice 4, I22): due now, then the shop's postings are sent. */
export async function retryInventoryPostingAction(
  postingId: string,
): Promise<ActionResult<{ status: "PENDING" | "DONE" | "FAILED" }>> {
  return run("/settings/inventory", (ctx, meta) => retryInventoryPosting(ctx, postingId, meta));
}

/** Settings → Shop (business-profiles-spec BP3): the business type. Owner only. */
export async function saveBusinessTypeAction(businessType: string): Promise<ActionResult<null>> {
  return run("/settings/shop", async (ctx, meta) => {
    await updateBusinessType(ctx, { businessType }, meta);
    return null;
  });
}

/** Settings → Tables (restaurant-cafe-spec R3): one branch's tables. Owner and Admin. */
export async function saveTablesAction(input: unknown): Promise<ActionResult<DiningTableRow[]>> {
  return run("/settings/tables", (ctx, meta) => saveTables(ctx, input, meta));
}

/** Settings → Shop (restaurant-cafe-spec R11): the dine-in service charge. Owner only. */
export async function saveServiceChargeAction(serviceChargeBp: number): Promise<ActionResult<null>> {
  return run("/settings/shop", async (ctx, meta) => {
    await updateServiceCharge(ctx, { serviceChargeBp }, meta);
    return null;
  });
}

/** Settings → Shop (weighed-selling-spec W6): scale labels. Owner only. */
export async function saveScaleSettingsAction(input: unknown): Promise<ActionResult<null>> {
  return run("/settings/shop", async (ctx, meta) => {
    await updateScaleSettings(ctx, input, meta);
    return null;
  });
}

/** Offline till (offline-till-spec OF5, OF16; slice 1): the shop toggle and revoking a till's device. Owner only. */
export async function setOfflineSalesAction(allowOfflineSales: boolean): Promise<ActionResult<null>> {
  return run("/settings/offline", async (ctx, meta) => {
    await updateOfflineSettings(ctx, { allowOfflineSales }, meta);
    return null;
  });
}

export async function revokeOfflineDeviceAction(registerId: string): Promise<ActionResult<null>> {
  return run("/settings/offline", async (ctx, meta) => {
    await revokeOfflineDevice(ctx, registerId, meta);
    return null;
  });
}
