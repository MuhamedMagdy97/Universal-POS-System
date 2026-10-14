import "server-only";
import { z } from "zod";
import { hashPassword } from "@/lib/auth/password";
import { getDb } from "@/lib/db";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { MARKET_PRESETS } from "@/modules/presets";
import { isUniqueViolation, orgConflict, type Tx } from "./access";
import { SetupInput } from "./schemas";

/**
 * Shop setup (onboarding O1, O2, O6–O8, O12): the account, shop, first branch, first till and the
 * Owner membership are created in one transaction, so a failure leaves nothing behind.
 */

export const FIRST_BRANCH_CODE = "MAIN";
export const FIRST_REGISTER_NAME = "Till 1";

export type ShopCreated = { orgId: string; branchId: string; registerId: string; userId: string };

const emailTaken = () => orgConflict("EMAIL_TAKEN", "An account with this email already exists");

/** Adds the email + password login (Better-Auth "credential" account: accountId = user id). */
export async function createLogin(
  tx: Tx,
  data: { name: string; email: string; passwordHash: string },
): Promise<{ id: string }> {
  if (await tx.user.findUnique({ where: { email: data.email }, select: { id: true } })) throw emailTaken();
  const user = await tx.user.create({ data: { name: data.name, email: data.email }, select: { id: true } });
  await tx.account.create({
    data: { accountId: user.id, providerId: "credential", userId: user.id, password: data.passwordHash },
  });
  return user;
}

/**
 * Creates a shop. `signedInUserId` is set when a signed-in user without a shop finishes setup (O7):
 * the account fields are then ignored and their sessions move into the new shop.
 */
export async function createShop(
  input: unknown,
  opts: { signedInUserId?: string | null; meta?: AuditRequestMeta } = {},
): Promise<ShopCreated> {
  const parsed = SetupInput.parse(input);
  const userId = opts.signedInUserId ?? null;
  const account = userId ? null : parsed.account;
  if (!userId && !account) {
    throw new z.ZodError([{ code: "custom", path: ["account"], message: "Account details are required", input }]);
  }
  const passwordHash = account ? await hashPassword(account.password) : null;
  const market = MARKET_PRESETS[parsed.country];

  try {
    return await getDb().$transaction(async (tx) => {
      let ownerId: string;
      if (account && passwordHash) {
        ownerId = (await createLogin(tx, { name: account.ownerName, email: account.email, passwordHash })).id;
      } else {
        ownerId = userId ?? "";
        // One shop per account (O8). The lock makes two setups in two tabs queue up.
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${ownerId}::uuid FOR UPDATE`;
        if (await tx.membership.findFirst({ where: { userId: ownerId }, select: { id: true } })) {
          throw orgConflict("ALREADY_IN_SHOP", "This account already belongs to a shop");
        }
      }

      const org = await tx.organization.create({
        data: {
          name: parsed.shopName,
          businessType: parsed.businessType,
          countryCode: market.country,
          currency: market.currency,
          vatRateBp: market.vatRateBp,
          pricesIncludeVat: true,
          blockNegativeStock: true,
        },
        select: { id: true },
      });
      const branch = await tx.branch.create({
        data: { orgId: org.id, name: parsed.branchName, code: FIRST_BRANCH_CODE },
        select: { id: true },
      });
      const register = await tx.register.create({
        data: { orgId: org.id, branchId: branch.id, name: FIRST_REGISTER_NAME },
        select: { id: true },
      });
      await tx.membership.create({ data: { orgId: org.id, userId: ownerId, role: "OWNER", allBranches: true } });
      if (!account) {
        await tx.session.updateMany({ where: { userId: ownerId }, data: { activeOrganizationId: org.id } });
      }

      await record(tx, {
        ctx: { orgId: org.id, branchId: branch.id, userId: ownerId },
        meta: opts.meta,
        action: "org.created",
        entityType: "Organization",
        entityId: org.id,
        metadata: {
          name: parsed.shopName,
          businessType: parsed.businessType,
          country: market.country,
          currency: market.currency,
          vatRateBp: market.vatRateBp,
          branchId: branch.id,
          registerId: register.id,
        },
      });
      return { orgId: org.id, branchId: branch.id, registerId: register.id, userId: ownerId };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw emailTaken();
    throw err;
  }
}
