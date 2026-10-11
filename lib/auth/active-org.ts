export type SessionMembership = { orgId: string; createdAt: Date };

/**
 * Chooses the organization a new session starts in, from the user's active memberships.
 *
 * - No active membership → `null` (the tenant guard then denies every tenant route).
 * - One membership → that org.
 * - Several → the oldest membership, so the choice is stable. A real org picker
 *   replaces this when it lands; until then the first org is the default.
 */
export function pickActiveOrganization(memberships: readonly SessionMembership[]): string | null {
  let oldest: SessionMembership | null = null;
  for (const membership of memberships) {
    if (
      oldest === null ||
      membership.createdAt.getTime() < oldest.createdAt.getTime() ||
      (membership.createdAt.getTime() === oldest.createdAt.getTime() && membership.orgId < oldest.orgId)
    ) {
      oldest = membership;
    }
  }
  return oldest?.orgId ?? null;
}
