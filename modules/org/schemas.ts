import { z } from "zod";
import { BUSINESS_TYPE_IDS } from "@/modules/presets";

/**
 * Input rules for shop setup, staff, branches and tills (onboarding spec O2, O3, O5, O9).
 * Client-safe: the forms import the limits from here.
 */

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

const name = (max: number) => z.string().trim().min(1).max(max);
export const Uuid = z.uuid();

export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const Password = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);
/** Branch short code: A–Z, 0–9 and dash, stored upper-case so uniqueness ignores case. */
export const BranchCode = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9-]{1,12}$/));

export const STAFF_ROLES = ["OWNER", "ADMIN", "MANAGER", "CASHIER", "REPORTING"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Owners and Admins are managed by Owners only (O4). */
export function canManageRole(actor: StaffRole, role: StaffRole): boolean {
  return actor === "OWNER" || (role !== "OWNER" && role !== "ADMIN");
}

/** The account fields, left out when a signed-in user without a shop finishes setup (O7). */
export const AccountInput = z.object({ ownerName: name(120), email: Email, password: Password });

export const SetupInput = z
  .object({
    businessType: z.enum(BUSINESS_TYPE_IDS),
    shopName: name(120),
    country: z.enum(["EG", "SA"]),
    branchName: name(60),
    account: AccountInput.optional(),
  })
  .strict();

/** All branches, or the listed ones (at least one). */
const BranchScope = z.union([
  z.object({ allBranches: z.literal(true) }).strict(),
  z.object({ allBranches: z.literal(false), branchIds: z.array(Uuid).min(1).max(200) }).strict(),
]);

export const StaffInput = z
  .object({ name: name(120), email: Email, password: Password, role: z.enum(STAFF_ROLES), branches: BranchScope })
  .strict();

export const StaffPatch = z
  .object({
    role: z.enum(STAFF_ROLES),
    branches: BranchScope,
    isActive: z.boolean(),
    /** A new temporary password set by the owner or an admin (R4). */
    password: Password,
  })
  .partial()
  .strict();

export const BranchInput = z.object({ name: name(60), code: BranchCode }).strict();
export const BranchPatch = z
  .object({ name: name(60), isActive: z.boolean() })
  .partial()
  .strict();

export const RegisterInput = z.object({ branchId: Uuid, name: name(40) }).strict();
export const RegisterPatch = z
  .object({ name: name(40), isActive: z.boolean() })
  .partial()
  .strict();

export const PasswordChangeInput = z.object({ currentPassword: z.string().min(1), newPassword: Password }).strict();
