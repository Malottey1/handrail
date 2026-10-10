/**
 * Exact decimal handling for PayPal amount strings. Amounts are compared as
 * integer hundredths so policy checks never touch floating point.
 */

const AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;

/** "12.5" -> 1250. Returns null for anything that isn't a plain non-negative amount. */
export function toHundredths(value: string): number | null {
  const match = AMOUNT.exec(value.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const result = whole * 100 + fraction;
  return Number.isSafeInteger(result) ? result : null;
}

/** 1250 -> "12.50" */
export function formatHundredths(hundredths: number): string {
  const whole = Math.floor(hundredths / 100);
  const fraction = String(hundredths % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

export interface Money {
  /** Integer hundredths of the currency unit. */
  hundredths: number;
  currency: string;
}

export function formatMoney(money: Money): string {
  return `${formatHundredths(money.hundredths)} ${money.currency}`;
}
