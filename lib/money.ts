/**
 * Money helpers. All amounts are integer minor units (piastres for EGP,
 * halalas for SAR). Floats are never used for arithmetic; percentage math
 * runs in BigInt and rounds half-up (away from zero) once per line.
 * See docs/product/business-rules.md (rules 1-3).
 */

export type CurrencyCode = "EGP" | "SAR";

export const CURRENCY_MINOR_DIGITS: Record<CurrencyCode, number> = { EGP: 2, SAR: 2 };

/** Upper bound of a Postgres `integer` column, where amounts are stored. */
export const MAX_STORABLE_MINOR = 2_147_483_647;

/** Basis points per 100%. 1400 bp = 14%. */
export const BP_SCALE = 10_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertMinor(value: number, label = "amount"): void {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of minor units, got ${String(value)}`);
  }
}

/** Throws if the amount cannot be stored in an integer column. */
export function assertStorable(value: number, label = "amount"): void {
  assertMinor(value, label);
  if (Math.abs(value) > MAX_STORABLE_MINOR) {
    throw new MoneyError(`${label} exceeds the storable range`);
  }
}

export function assertRateBp(rateBp: number): void {
  if (!Number.isSafeInteger(rateBp) || rateBp < 0 || rateBp > BP_SCALE) {
    throw new MoneyError(`rate must be an integer between 0 and ${BP_SCALE} basis points`);
  }
}

function toSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError(`${label} overflowed the safe integer range`);
  }
  return Number(value);
}

/** Integer division rounding half away from zero. `divisor` must be positive. */
export function divideRoundHalfUp(numerator: bigint, divisor: bigint): bigint {
  if (divisor <= BigInt(0)) throw new MoneyError("divisor must be positive");
  const negative = numerator < BigInt(0);
  const abs = negative ? -numerator : numerator;
  const quotient = (abs * BigInt(2) + divisor) / (divisor * BigInt(2));
  return negative ? -quotient : quotient;
}

export function sum(values: readonly number[]): number {
  let total = BigInt(0);
  for (const value of values) {
    assertMinor(value);
    total += BigInt(value);
  }
  return toSafeNumber(total, "sum");
}

export function multiply(unitMinor: number, qty: number): number {
  assertMinor(unitMinor, "unit amount");
  assertMinor(qty, "quantity");
  return toSafeNumber(BigInt(unitMinor) * BigInt(qty), "line amount");
}

/** `amount × rateBp / 10000`, rounded half-up. */
export function percentOfBp(amountMinor: number, rateBp: number): number {
  assertMinor(amountMinor);
  assertRateBp(rateBp);
  return toSafeNumber(divideRoundHalfUp(BigInt(amountMinor) * BigInt(rateBp), BigInt(BP_SCALE)), "percentage");
}

/** VAT to add on top of a VAT-exclusive (net) line amount. */
export function vatOnNet(netMinor: number, rateBp: number): number {
  return percentOfBp(netMinor, rateBp);
}

/** VAT contained in a VAT-inclusive (gross) line amount: gross − round(gross / (1 + rate)). */
export function vatInGross(grossMinor: number, rateBp: number): number {
  assertMinor(grossMinor);
  assertRateBp(rateBp);
  const net = divideRoundHalfUp(BigInt(grossMinor) * BigInt(BP_SCALE), BigInt(BP_SCALE + rateBp));
  return toSafeNumber(BigInt(grossMinor) - net, "vat");
}

const MAJOR_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Parse a decimal string such as "12.50" into minor units without floats. */
export function parseMajor(input: string, currency: CurrencyCode): number {
  const digits = CURRENCY_MINOR_DIGITS[currency];
  const match = MAJOR_PATTERN.exec(input.trim());
  if (!match) throw new MoneyError(`"${input}" is not a valid amount`);
  const [, sign, whole = "0", fraction = ""] = match;
  if (fraction.length > digits) {
    throw new MoneyError(`${currency} amounts allow at most ${digits} decimal places`);
  }
  const minor = BigInt(whole) * BigInt(10) ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  return toSafeNumber(sign ? -minor : minor, "amount");
}

/** Exact decimal string for minor units, e.g. 1250 → "12.50". */
export function toMajorString(minor: number, currency: CurrencyCode): string {
  assertMinor(minor);
  const digits = CURRENCY_MINOR_DIGITS[currency];
  const negative = minor < 0;
  const abs = String(Math.abs(minor)).padStart(digits + 1, "0");
  const whole = abs.slice(0, abs.length - digits);
  const fraction = abs.slice(abs.length - digits);
  return `${negative ? "-" : ""}${whole}${digits > 0 ? `.${fraction}` : ""}`;
}

/** Locale-aware display. Intl formats the exact decimal string, so no float rounding occurs. */
export function formatMoney(minor: number, currency: CurrencyCode, locale = "en"): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: CURRENCY_MINOR_DIGITS[currency],
    maximumFractionDigits: CURRENCY_MINOR_DIGITS[currency],
  });
  return formatter.format(toMajorString(minor, currency) as Intl.StringNumericLiteral);
}
