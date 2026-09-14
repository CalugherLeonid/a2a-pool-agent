/**
 * Primitive types used across the entire codebase.
 *
 * Conventions:
 * - Monetary values are USD-normalized for all arithmetic. Conversion from
 *   platform currencies (USDC, OKB, ...) happens at the adapter boundary.
 * - Hashes and signatures are prefixed with their algorithm.
 * - Timestamps are ISO 8601 UTC strings.
 */

/** A UUID v4 string. */
export type Uuid = string;

/** An ISO 8601 UTC timestamp, e.g. "2026-09-13T14:32:00.000Z". */
export type Iso8601 = string;

/** A SHA-256 hash, prefixed, e.g. "sha256:a3f1...". */
export type Sha256Hash = `sha256:${string}`;

/** An Ed25519 signature, prefixed, e.g. "ed25519:9c2b...". */
export type Ed25519Sig = `ed25519:${string}`;

/** An HMAC-SHA256 signature, prefixed. */
export type HmacSig = `hmac-sha256:${string}`;

/**
 * A monetary amount denominated in USD.
 *
 * V1 CAVEAT: stored as `number` (IEEE 754). All arithmetic MUST go through
 * `core/money` helpers backed by decimal.js. The ledger persists these as
 * NUMERIC(20, 8) in Postgres.
 */
export type Usd = number;

/** A probability in the closed interval [0, 1]. */
export type Probability = number;

/** A quality score in the closed interval [0, 1], where 1 is perfect. */
export type QualityScore = number;

/** Supported currencies across all adapters. */
export type CurrencyCode = 'USD' | 'USDC' | 'OKB' | 'INTERNAL';

/** Supported settlement chains / rails. */
export type ChainId =
  | 'solana'
  | 'xlayer'
  | 'monad'
  | 'stripe'
  | 'bsc'
  | 'bsc-testnet';

/** Lifecycle status of a settlement. */
export type SettlementStatus =
  | 'pending'
  | 'settled'
  | 'failed'
  | 'pending_human_claim';

/** Provider identifier for LLM calls. */
export type LlmProvider = 'google' | 'groq' | 'openrouter' | 'deepseek' | 'anthropic';