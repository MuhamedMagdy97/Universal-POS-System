import "server-only";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { TenantContext } from "@/lib/auth/tenant";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { record, type AuditRequestMeta } from "@/modules/audit";
import { PasswordChangeInput } from "./schemas";

/**
 * My account (onboarding O10): anyone signed in changes their own password with the current one.
 * Their other sessions end; the one in use (`keepSessionId`) stays signed in.
 */
export async function changeOwnPassword(
  ctx: TenantContext,
  input: unknown,
  opts: { keepSessionId: string; meta?: AuditRequestMeta },
): Promise<void> {
  const data = PasswordChangeInput.parse(input);
  const db = getDb();
  const account = await db.account.findFirst({
    where: { userId: ctx.userId, providerId: "credential" },
    select: { id: true, password: true },
  });
  if (!account?.password || !(await verifyPassword({ hash: account.password, password: data.currentPassword }))) {
    throw new AppError("VALIDATION_FAILED", "The current password is not correct", { reason: "WRONG_PASSWORD" });
  }
  const passwordHash = await hashPassword(data.newPassword);
  await db.$transaction(async (tx) => {
    await tx.account.update({ where: { id: account.id }, data: { password: passwordHash } });
    await tx.session.deleteMany({ where: { userId: ctx.userId, id: { not: opts.keepSessionId } } });
    await record(tx, {
      ctx,
      meta: opts.meta,
      action: "account.password_changed",
      entityType: "User",
      entityId: ctx.userId,
    });
  });
}
