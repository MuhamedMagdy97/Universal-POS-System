"use server";
/**
 * Settings Server Actions: receipt (T10 H3), staff, branches and tills (onboarding), and the inventory-system
 * link (Phase 13). Thin adapters over modules/org and modules/integrations/inventory-sys.
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
  updateReceiptSettings,
  updateRegister,
  updateStaff,
  type ReceiptSettings,
  type ReceiptSettingsInput,
} from "@/modules/org";
import {
  checkInventoryLink,
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

export async function syncInventoryAction(): Promise<ActionResult<SyncSummary>> {
  return run("/settings/inventory", (ctx, meta) => syncInventoryNow(ctx, meta));
}
