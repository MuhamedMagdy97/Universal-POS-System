import { describe, expect, it } from "vitest";
import { normalizePhone, phoneSearchDigits } from "@/modules/customers/phone";
import { customerErrorKey, takenCustomerId } from "@/app/(app)/customers/_lib/customers";

/** Phone numbers to E.164 for EG and SA shops (customers-spec CU2). */

describe("normalizePhone", () => {
  it("reads Egyptian mobiles and landlines in every common way", () => {
    for (const raw of [
      "01001234567",
      "0100 123 4567",
      "0100-123-4567",
      "+20 100 123 4567",
      "00201001234567",
      "201001234567",
      "+20 0100 123 4567",
    ]) {
      expect(normalizePhone(raw, "EG")).toBe("+201001234567");
    }
    expect(normalizePhone("٠١٠٠١٢٣٤٥٦٧", "EG")).toBe("+201001234567");
    expect(normalizePhone("01512345678", "EG")).toBe("+201512345678");
    expect(normalizePhone("(02) 2345 6789", "EG")).toBe("+20223456789");
    expect(normalizePhone("03 4567890", "EG")).toBe("+2034567890");
  });

  it("reads Saudi mobiles and landlines", () => {
    for (const raw of ["0501234567", "050 123 4567", "+966 50 123 4567", "00966501234567", "966501234567"]) {
      expect(normalizePhone(raw, "SA")).toBe("+966501234567");
    }
    expect(normalizePhone("011 234 5678", "SA")).toBe("+966112345678");
  });

  it("keeps a foreign number typed with + or 00, and checks a known country's own rules", () => {
    expect(normalizePhone("+44 20 7946 0958", "EG")).toBe("+442079460958");
    expect(normalizePhone("0044 20 7946 0958", "SA")).toBe("+442079460958");
    // A Saudi number in an Egyptian shop is still read by Saudi rules.
    expect(normalizePhone("+966 50 123 4567", "EG")).toBe("+966501234567");
    expect(normalizePhone("+966 40 123 4567", "EG")).toBeNull();
  });

  it("refuses what is not a phone number in the shop's country", () => {
    for (const raw of [
      "",
      "abc",
      "0100123456",
      "010012345678",
      "01301234567",
      "12345",
      "+20 13 0123 4567",
      "+0123456789",
      "0100 123 4567 ext 2",
    ]) {
      expect(normalizePhone(raw, "EG")).toBeNull();
    }
    // An Egyptian local mobile is not a Saudi number.
    expect(normalizePhone("01001234567", "SA")).toBeNull();
    expect(normalizePhone("0401234567", "SA")).toBeNull();
  });
});

describe("phoneSearchDigits", () => {
  it("drops the trunk 0 and the 00 prefix so a local search matches the stored E.164", () => {
    expect(phoneSearchDigits("0100 123")).toBe("100123");
    expect(phoneSearchDigits("00966 50")).toBe("96650");
    expect(phoneSearchDigits("٠١٠٠")).toBe("100");
    expect(phoneSearchDigits("Ahmed")).toBeNull();
    expect(phoneSearchDigits("01")).toBeNull();
  });
});

describe("customer error messages", () => {
  it("names phone problems and hands back the existing customer on a clash", () => {
    const taken = { code: "CONFLICT" as const, message: "", details: { reason: "PHONE_TAKEN", customerId: "c1" } };
    expect(customerErrorKey(taken)).toBe("customers.error.phoneTaken");
    expect(takenCustomerId(taken)).toBe("c1");
    expect(customerErrorKey({ code: "VALIDATION_FAILED", message: "", details: { reason: "INVALID_PHONE" } })).toBe(
      "customers.error.phone",
    );
    expect(customerErrorKey({ code: "FORBIDDEN", message: "", details: null })).toBe("customers.error.forbidden");
    expect(takenCustomerId({ code: "FORBIDDEN", message: "", details: null })).toBeNull();
  });
});
