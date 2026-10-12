import { describe, expect, it } from "vitest";
import { decodeAuditCursor, encodeAuditCursor } from "@/modules/reports/schemas";

const id = "7f00286f-efb9-4e9e-a5dc-073e29e4c1d8";

describe("audit cursor", () => {
  it("round-trips", () => {
    const cursor = { at: "2026-03-10T13:00:00.123Z", id };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it("refuses anything it did not write", () => {
    expect(decodeAuditCursor("not-a-cursor")).toBeNull();
    expect(decodeAuditCursor(encodeAuditCursor({ at: "yesterday", id }))).toBeNull();
    expect(decodeAuditCursor(encodeAuditCursor({ at: "2026-03-10T13:00:00.123Z", id: "x" }))).toBeNull();
    expect(decodeAuditCursor(Buffer.from(`2026-03-10T13:00:00.123Z|${id}|extra`).toString("base64url"))).toBeNull();
  });
});
