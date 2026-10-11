import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { LOGIN_RATE_LIMIT, getAuth } from "@/lib/auth/auth";
import { testDb } from "./helpers";

/** Real Better-Auth handler + real Postgres: password hashing, DB sessions, revoke, login rate limit. */
const BASE = "http://localhost:3000/api/auth";
const PASSWORD = "correct horse battery";
let db: Db;

function post(path: string, body: unknown, ip: string, cookie?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: "http://localhost:3000",
    "x-forwarded-for": ip,
  };
  if (cookie) headers.cookie = cookie;
  return getAuth().handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie();
  const token = cookies.find((cookie) => cookie.includes("session_token="));
  if (!token) throw new Error("no session cookie returned");
  return token.split(";")[0] ?? "";
}

function randomIp() {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
}

beforeAll(() => {
  db = testDb();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("auth", () => {
  it("stores an argon2id hash, never the plain password", async () => {
    const email = `owner-${randomUUID()}@example.test`;
    const response = await post("/sign-up/email", { email, password: PASSWORD, name: "Owner" }, randomIp());
    expect(response.status).toBe(200);
    const account = await db.account.findFirst({ where: { user: { email } } });
    expect(account?.password).toMatch(/^\$argon2id\$/);
    expect(account?.password).not.toContain(PASSWORD);
  });

  it("creates a database session on sign-in and revokes it", async () => {
    const email = `cashier-${randomUUID()}@example.test`;
    await post("/sign-up/email", { email, password: PASSWORD, name: "Cashier" }, randomIp());

    const signIn = await post("/sign-in/email", { email, password: PASSWORD }, randomIp());
    expect(signIn.status).toBe(200);
    const cookie = sessionCookie(signIn);
    const headers = new Headers({ cookie });

    const session = await getAuth().api.getSession({ headers });
    expect(session?.user.email).toBe(email);
    expect(await db.session.count({ where: { userId: session?.user.id } })).toBeGreaterThan(0);

    await getAuth().api.revokeSessions({ headers });
    expect(await getAuth().api.getSession({ headers })).toBeNull();
    expect(await db.session.count({ where: { userId: session?.user.id } })).toBe(0);
  });

  it("rejects a wrong password", async () => {
    const email = `wrong-${randomUUID()}@example.test`;
    await post("/sign-up/email", { email, password: PASSWORD, name: "Wrong" }, randomIp());
    const response = await post("/sign-in/email", { email, password: "not the password" }, randomIp());
    expect(response.status).toBe(401);
  });

  it(`rate-limits sign-in after ${LOGIN_RATE_LIMIT.max} attempts per window`, async () => {
    const ip = randomIp();
    const email = `brute-${randomUUID()}@example.test`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.max + 2; attempt += 1) {
      const response = await post("/sign-in/email", { email, password: "guess" }, ip);
      statuses.push(response.status);
    }
    expect(statuses.slice(0, LOGIN_RATE_LIMIT.max).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(LOGIN_RATE_LIMIT.max)).toEqual([429, 429]);
  });
});
