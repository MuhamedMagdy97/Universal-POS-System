import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";

const valid = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:pw@localhost:5432/db",
  AUTH_SECRET: "x".repeat(32),
} as NodeJS.ProcessEnv;

describe("config", () => {
  it("accepts a complete environment", () => {
    expect(getConfig(valid).DATABASE_URL).toBe(valid.DATABASE_URL);
  });

  it("rejects a short AUTH_SECRET and names the key, not the value", () => {
    expect(() => getConfig({ ...valid, AUTH_SECRET: "short-secret-value" })).toThrow(/AUTH_SECRET/);
    expect(() => getConfig({ ...valid, AUTH_SECRET: "short-secret-value" })).not.toThrow(/short-secret-value/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => getConfig({ ...valid, DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });
});
