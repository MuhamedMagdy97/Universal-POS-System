import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, errorResponse, forbidden, notFound, toErrorBody, unauthenticated } from "@/lib/errors";

describe("error envelope", () => {
  it("maps AppError to its status and body", () => {
    expect(toErrorBody(unauthenticated())).toEqual({
      status: 401,
      body: { code: "UNAUTHENTICATED", message: "Authentication required", details: null },
    });
    expect(toErrorBody(forbidden()).status).toBe(403);
    expect(toErrorBody(notFound("Branch")).body).toEqual({
      code: "NOT_FOUND",
      message: "Branch not found",
      details: null,
    });
    expect(toErrorBody(new AppError("IDEMPOTENCY_CONFLICT", "Key reused", { key: "k1" })).status).toBe(409);
  });

  it("maps Zod failures to 422 with field paths", () => {
    const result = z.object({ qty: z.number().int().positive() }).safeParse({ qty: -1 });
    expect(result.success).toBe(false);
    const { status, body } = toErrorBody(result.error);
    expect(status).toBe(422);
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.details).toEqual([expect.objectContaining({ path: "qty" })]);
  });

  it("maps Prisma unique and foreign-key errors without leaking metadata", () => {
    const unique = { name: "PrismaClientKnownRequestError", code: "P2002", meta: { target: ["orgId", "sku"] } };
    expect(toErrorBody(unique)).toEqual({
      status: 409,
      body: { code: "CONFLICT", message: "A record with these values already exists", details: null },
    });
    const fk = { name: "PrismaClientKnownRequestError", code: "P2003", meta: { field_name: "Sale_orgId_fkey" } };
    expect(toErrorBody(fk).status).toBe(404);
  });

  it("hides unknown errors behind a generic 500", () => {
    const { status, body } = toErrorBody(new Error("connection string postgres://user:secret@db"));
    expect(status).toBe(500);
    expect(body).toEqual({ code: "INTERNAL", message: "An unexpected error occurred", details: null });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("builds a JSON response with the request id", async () => {
    const response = errorResponse(forbidden(), "req-123");
    expect(response.status).toBe(403);
    expect(response.headers.get("x-request-id")).toBe("req-123");
    expect(await response.json()).toEqual({
      code: "FORBIDDEN",
      message: "You do not have access to this resource",
      details: null,
    });
  });
});
