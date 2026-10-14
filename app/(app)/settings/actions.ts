"use server";
/** Settings Server Actions: receipt (T10 H3), staff, branches and tills (onboarding). Thin adapters over modules/org. */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireTenant, type TenantContext } from "@/lib/auth/tenant";
import { toErrorBody, type ErrorBody } from "@/lib/errors";
import { getRequestId } from "@/lib/http";
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
    return { ok: false, error: toErrorBody(err).body };
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
    return { ok: false, error: toErrorBody(err).body };
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
