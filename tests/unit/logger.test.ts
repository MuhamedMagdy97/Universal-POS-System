import { describe, expect, it } from "vitest";
import { REDACTED, createLogger, redact, type LogLevel } from "@/lib/logger";

function capture() {
  const lines: { level: LogLevel; entry: Record<string, unknown> }[] = [];
  const log = createLogger({}, (level, line) => lines.push({ level, entry: JSON.parse(line) }));
  return { log, lines };
}

describe("structured logger", () => {
  it("writes one JSON line with request, org and actor context", () => {
    const { log, lines } = capture();
    log.child({ requestId: "req-1", orgId: "org-1", actor: "user-1" }).info("sale created", { saleId: "s-1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("info");
    expect(lines[0]?.entry).toMatchObject({
      level: "info",
      msg: "sale created",
      requestId: "req-1",
      orgId: "org-1",
      actor: "user-1",
      saleId: "s-1",
    });
  });

  it("redacts secrets at any depth", () => {
    const { log, lines } = capture();
    log.warn("login attempt", {
      email: "a@b.c",
      password: "hunter2",
      headers: { authorization: "Bearer abc", Cookie: "session=xyz" },
      nested: [{ apiKey: "k", DATABASE_URL: "postgres://u:p@h/db", sessionToken: "t" }],
    });
    const serialized = JSON.stringify(lines[0]?.entry);
    for (const secret of ["hunter2", "Bearer abc", "session=xyz", "postgres://", '"t"']) {
      expect(serialized).not.toContain(secret);
    }
    expect(lines[0]?.entry).toMatchObject({ email: "a@b.c", password: REDACTED });
  });

  it("serialises errors as name and message only", () => {
    expect(redact({ error: new TypeError("boom") })).toEqual({ error: { name: "TypeError", message: "boom" } });
  });
});
