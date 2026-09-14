/**
 * Financial arithmetic helpers.
 *
 * All monetary values in types are `Usd = number`. But every arithmetic
 * operation MUST go through this module. `number` is only the boundary
 * representation (JSON, DB); internally we use Decimal for exactness.
 *
 * Ledger values are persisted as NUMERIC(20, 8) in Postgres. Use
 * `toDbNumeric()` when writing and `fromDbNumeric()` when reading.
 */

import { Decimal } from 'decimal.js';

Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -20,
  toExpPos: 20,
});

export type Numeric = number | string | Decimal;

/** Construct a Decimal from any numeric representation. */
export function usd(value: Numeric): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

// --- Arithmetic ----------------------------------------------------

export function add(a: Numeric, b: Numeric): Decimal {
  return usd(a).plus(usd(b));
}

export function sub(a: Numeric, b: Numeric): Decimal {
  return usd(a).minus(usd(b));
}

export function mul(a: Numeric, b: Numeric): Decimal {
  return usd(a).times(usd(b));
}

export function div(a: Numeric, b: Numeric): Decimal {
  return usd(a).div(usd(b));
}

export function min(a: Numeric, b: Numeric): Decimal {
  return Decimal.min(usd(a), usd(b));
}

export function max(a: Numeric, b: Numeric): Decimal {
  return Decimal.max(usd(a), usd(b));
}

export function abs(a: Numeric): Decimal {
  return usd(a).abs();
}

export function neg(a: Numeric): Decimal {
  return usd(a).negated();
}

// --- Comparison ----------------------------------------------------

export function eq(a: Numeric, b: Numeric): boolean {
  return usd(a).eq(usd(b));
}

export function gt(a: Numeric, b: Numeric): boolean {
  return usd(a).gt(usd(b));
}

export function gte(a: Numeric, b: Numeric): boolean {
  return usd(a).gte(usd(b));
}

export function lt(a: Numeric, b: Numeric): boolean {
  return usd(a).lt(usd(b));
}

export function lte(a: Numeric, b: Numeric): boolean {
  return usd(a).lte(usd(b));
}

export function isZero(a: Numeric): boolean {
  return usd(a).isZero();
}

export function isPositive(a: Numeric): boolean {
  return usd(a).isPositive() && !usd(a).isZero();
}

// --- Boundaries ----------------------------------------------------

/** Convert to a JS `number` for JSON serialization or type boundaries. */
export function toNumber(d: Numeric): number {
  return usd(d).toNumber();
}

/** Format for NUMERIC(20, 8) columns in Postgres. */
export function toDbNumeric(d: Numeric): string {
  return usd(d).toFixed(8);
}

/** Parse a NUMERIC(20, 8) string returned by Postgres. */
export function fromDbNumeric(s: string): Decimal {
  return new Decimal(s);
}
