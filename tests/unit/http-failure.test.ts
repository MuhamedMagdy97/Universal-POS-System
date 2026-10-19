import { beforeEach, describe, expect, it, vi } from "vitest";

const ping = vi.fn<() => Promise<unknown>>();
vi.mock("@/lib/db", () => ({ getDb: () => ({ $queryRaw: () => ping() }) }));

const { actionError, failureOf, handleRoute } = await import("@/lib/http");
const { AppError } = await import("@/lib/errors");

describe("failureOf", () => {
  beforeEach(() => {
    ping.mockReset();
  });

  it("keeps 500 INTERNAL while the database answers", async () => {
    ping.mockResolvedValue([{ "?column?": 1 }]);
    expect(await failureOf(new Error("boom"))).toMatchObject({ status: 500, body: { code: "INTERNAL" } });
  });

  it("turns an unexpected error into 503 DB_UNAVAILABLE when the ping fails", async () => {
    ping.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await failureOf(new Error("Failed to get session"))).toEqual({
      status: 503,
      body: { code: "DB_UNAVAILABLE", message: "Database is unavailable", details: null },
    });
  });

  it("treats a ping that never answers as unreachable", async () => {
    ping.mockReturnValue(new Promise(() => {}));
    const result = failureOf(new Error("hang"));
    expect((await result).status).toBe(503); // after the 2 s ping timeout
  });

  it("leaves known errors alone without pinging", async () => {
    expect((await failureOf(new AppError("FORBIDDEN", "no"))).status).toBe(403);
    expect(ping).not.toHaveBeenCalled();
  });

  it("serves 503 from route handlers and Server Actions", async () => {
    ping.mockImplementation(async () => {
      throw new Error("down");
    });
    const route = handleRoute(async () => {
      throw new Error("Failed to get session");
    });
    const response = await route(new Request("http://x/api/sales"), undefined);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect((await actionError(new Error("down"), "pos")).code).toBe("DB_UNAVAILABLE");
  });
});
