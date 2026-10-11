import "server-only";
import { getAuth, type AuthSession } from "@/lib/auth/auth";

export type SessionIdentity = {
  userId: string;
  sessionId: string;
  activeOrganizationId: string | null;
  activeBranchId: string | null;
};

export function toIdentity(session: AuthSession | null): SessionIdentity | null {
  if (!session) return null;
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    activeOrganizationId: session.session.activeOrganizationId ?? null,
    activeBranchId: session.session.activeBranchId ?? null,
  };
}

/** Validates the session cookie against the database (expired or revoked → null). */
export async function getSession(headers: Headers): Promise<AuthSession | null> {
  return getAuth().api.getSession({ headers });
}

/** Revoke one session of the current user by its token. */
export async function revokeSession(headers: Headers, token: string): Promise<void> {
  await getAuth().api.revokeSession({ headers, body: { token } });
}

/** Revoke every session of the current user (e.g. "sign out everywhere"). */
export async function revokeAllSessions(headers: Headers): Promise<void> {
  await getAuth().api.revokeSessions({ headers });
}
