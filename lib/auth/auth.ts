import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { pickActiveOrganization } from "@/lib/auth/active-org";

export const SESSION_TTL_SECONDS = 60 * 60 * 12; // one working day
export const LOGIN_RATE_LIMIT = { window: 60, max: 5 } as const;

function buildAuth() {
  const config = getConfig();
  return betterAuth({
    secret: config.AUTH_SECRET,
    baseURL: config.AUTH_URL,
    database: prismaAdapter(getDb(), { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    // Sessions live in the database so they can be listed and revoked.
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 60 * 60,
      additionalFields: {
        // Set server-side only (input: false); the tenant guard reads these.
        activeOrganizationId: { type: "string", required: false, input: false },
        activeBranchId: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Every new session starts in the user's organization, so the tenant guard
          // has an active org right after sign-in. An org picker can override it later.
          before: async (session) => {
            const memberships = await getDb().membership.findMany({
              where: { userId: session.userId, isActive: true },
              select: { orgId: true, createdAt: true },
            });
            return { data: { ...session, activeOrganizationId: pickActiveOrganization(memberships) } };
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": LOGIN_RATE_LIMIT,
        "/sign-up/email": LOGIN_RATE_LIMIT,
      },
    },
    advanced: {
      database: { generateId: "uuid" },
    },
    telemetry: { enabled: false },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof buildAuth>;
export type AuthSession = Auth["$Infer"]["Session"];

let instance: Auth | undefined;

/** Lazily built so importing route modules never requires env at build time. */
export function getAuth(): Auth {
  instance ??= buildAuth();
  return instance;
}
