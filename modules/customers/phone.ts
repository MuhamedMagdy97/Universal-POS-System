import { normalizeDigits } from "@/lib/money";

/**
 * Phone numbers to E.164 (customers-spec CU2). Pure: the till and tests import it. A local number
 * is read in the shop's country; a foreign one must carry `+` or `00`.
 */

export type PhoneCountry = "EG" | "SA";

const COUNTRY: Record<PhoneCountry, { code: string; national: RegExp }> = {
  // Mobile 1[0125] + 8 digits; landline area code 2–9 + 7–8 digits.
  EG: { code: "20", national: /^(1[0125]\d{8}|[2-9]\d{7,8})$/ },
  // Mobile 5 + 8 digits; landline 1[1-7] + 7 digits.
  SA: { code: "966", national: /^(5\d{8}|1[1-7]\d{7})$/ },
};

/** `+201001234567` for "0100 123 4567" in Egypt, or null when it is not a phone number there. */
export function normalizePhone(raw: string, country: PhoneCountry): string | null {
  const text = normalizeDigits(raw).trim();
  if (!/^\+?[\d\s\-().]+$/.test(text)) return null;
  let digits = text.replace(/\D/g, "");
  const international = text.startsWith("+") || digits.startsWith("00");
  if (digits.startsWith("00")) digits = digits.slice(2);
  const { code, national } = COUNTRY[country];

  if (!international) {
    // Local "0…", or the national number with the country code but no "+".
    if (digits.startsWith("0")) digits = digits.slice(1);
    else if (digits.startsWith(code) && national.test(digits.slice(code.length))) digits = digits.slice(code.length);
    return national.test(digits) ? `+${code}${digits}` : null;
  }
  for (const known of Object.values(COUNTRY)) {
    if (digits.startsWith(known.code)) {
      // Some people keep the trunk 0: +20 0100…
      const rest = digits.slice(known.code.length).replace(/^0/, "");
      return known.national.test(rest) ? `+${known.code}${rest}` : null;
    }
  }
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

/** The digits to look for when a cashier types part of a phone: no trunk 0, no country prefix signs. */
export function phoneSearchDigits(raw: string): string | null {
  const digits = normalizeDigits(raw).replace(/\D/g, "").replace(/^00/, "").replace(/^0/, "");
  return digits.length >= 3 ? digits : null;
}
