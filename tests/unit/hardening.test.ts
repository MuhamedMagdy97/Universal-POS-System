import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "@/next.config";
import { bucketOf, RATE_LIMITS, rateLimited, windowStartOf } from "@/lib/rate-limit";
import { errorResponse } from "@/lib/errors";

describe("rate limit buckets (T10 H6)", () => {
  const req = (method: string, path = "/api/x") => new Request(`http://localhost${path}`, { method });

  it("splits reads, writes and CSV exports", () => {
    expect(bucketOf(req("GET"))).toBe("read");
    expect(bucketOf(req("HEAD"))).toBe("read");
    expect(bucketOf(req("GET", "/api/reports/vat?format=csv"))).toBe("export");
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) expect(bucketOf(req(method))).toBe("write");
    expect(RATE_LIMITS).toEqual({ read: 600, write: 120, export: 10 });
  });

  it("uses fixed 60 s windows", () => {
    expect(windowStartOf(new Date("2026-10-13T10:00:59.999Z")).toISOString()).toBe("2026-10-13T10:00:00.000Z");
    expect(windowStartOf(new Date("2026-10-13T10:01:00.000Z")).toISOString()).toBe("2026-10-13T10:01:00.000Z");
  });

  it("answers 429 RATE_LIMITED with Retry-After", async () => {
    const response = errorResponse(rateLimited(17), "req-1");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSeconds: 17 } });
  });
});

describe("security headers (T10 H5)", () => {
  const header = (key: string) => SECURITY_HEADERS.find((h) => h.key === key)?.value;

  it("sets the baseline headers", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("ships a static CSP that forbids framing and foreign scripts", () => {
    const csp = header("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline'/);
  });
});
