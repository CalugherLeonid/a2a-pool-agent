/**
 * Environment configuration loader.
 *
 * Validates all env vars against a zod schema at startup. Fails fast with
 * a human-readable error if anything is missing or malformed.
 *
 * Empty strings are treated as \`undefined\` so that \`.optional()\` works
 * as expected with placeholder entries in \`.env\`.
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { z } from 'zod';

const EnvSchema = z.object({
  // --- Agent Identity ---------------------------------------------
  AGENT_ID: z.string().uuid().default('00000000-0000-0000-0000-000000000000'),
  AGENT_NAME: z.string().min(1).default('agent-001'),
  AGENT_ED25519_KEY_PATH: z.string().min(1).default('./keys/agent.key'),
  AGENT_SOLANA_KEY_PATH: z.string().min(1).optional(),

  /** Which set of learning events this agent instance is allowed to
   *  read/write. Prevents simulation data from contaminating real
   *  learning, and vice versa. */
  AGENT_ENVIRONMENT: z
    .enum(['development', 'staging', 'production'])
    .default('development'),

  // --- Database ---------------------------------------------------
  DATABASE_URL: z
    .string()
    .url()
    .default('postgresql://mock:mock@localhost:5432/mock_a2a'),

  // --- LLM Providers ----------------------------------------------
  GEMINI_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
  GROQ_MODEL: z.string().min(1).default('openai/gpt-oss-120b'),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().min(1).default('openrouter/free'),

  // --- Adapters ---------------------------------------------------
  RAILWAY_POOL_URL: z.string().url().optional(),
  RAILWAY_WORKER_ID: z.string().min(1).optional(),
  OKX_AGENT_TASK_HOME: z.string().min(1).optional(),
  OKX_MODE: z.enum(['demo', 'live']).default('demo'),
  CLUSTLY_API_KEY: z.string().min(1).optional(),

  // --- Economics --------------------------------------------------
  DAILY_BUDGET_USD: z.coerce.number().positive().default(5.0),
  PER_TASK_BUDGET_USD: z.coerce.number().positive().default(0.5),
  PER_TASK_HARD_FLOOR_USD: z.coerce.number().positive().default(0.3),
  MIN_PROFIT_USD: z.coerce.number().nonnegative().default(0.05),
  MIN_SUCCESS_PROBABILITY: z.coerce.number().min(0).max(1).default(0.7),
  MIN_TIME_ADJUSTED_PROFIT: z.coerce.number().nonnegative().default(0.1),

  // --- Runtime ----------------------------------------------------
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  CORE_PORT: z.coerce.number().int().positive().default(3000),
  GATEWAY_PORT: z.coerce.number().int().positive().default(8000),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  // --- Production & Hardening --------------------------------------
  STATE_PERSISTENCE_DIR: z.string().min(1).default('./data/state'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  A2A_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  CIRCUIT_BREAKER_FAILURES: z.coerce.number().int().positive().default(3),
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  ENABLE_PROMETHEUS_METRICS: z.coerce.boolean().default(true),

  // --- Ratchet & Morphling Immune System ---------------------------
  RATCHET_MIN_DELTA: z.coerce.number().min(0).max(1).default(0.05),

  // --- Dynamic Pricing Engine --------------------------------------
  DYNAMIC_PRICING_BASE_PRICE_USD: z.coerce.number().positive().default(0.05),
  DYNAMIC_PRICING_MIN_REWARD_USD: z.coerce.number().positive().default(0.05),
  DYNAMIC_PRICING_MAX_HIKE_RATIO: z.coerce.number().min(0).max(1).default(0.10),

  // --- Timeouts ----------------------------------------------------
  A2A_TASK_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // --- Reputation Weights -----------------------------------------
  REPUTATION_DELIVERY_WEIGHT: z.coerce.number().min(0).max(1).default(0.40),
  REPUTATION_DEADLINE_WEIGHT: z.coerce.number().min(0).max(1).default(0.20),
  REPUTATION_EVAL_WEIGHT: z.coerce.number().min(0).max(1).default(0.25),
  REPUTATION_EVOLUTION_WEIGHT: z.coerce.number().min(0).max(1).default(0.15),

  // --- Solana Receive Wallet ---------------------------------------
  SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  SOLANA_RECEIVE_ADDRESS: z.string().min(32).default('3t7xtNf5vyb7XKMFoNXaZJ7yW4dx8L8CN1LjcCLEacER'),
  USDC_MINT: z.string().min(32).default('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
});

export type Env = z.infer<typeof EnvSchema>;

const cleaned: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(process.env)) {
  cleaned[key] = value === '' ? undefined : value;
}

const parsed = EnvSchema.safeParse(cleaned);

if (!parsed.success) {
  console.error('[config] Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.') || '(root)';
    console.error('  - ' + path + ': ' + issue.message);
  }
  console.error('\nCheck your .env file against .env.example.');
  process.exit(1);
}

export const env: Env = parsed.data;
