/**
 * Environment configuration loader.
 *
 * Validates all env vars against a zod schema at startup. Fails fast with
 * a human-readable error if anything is missing or malformed.
 *
 * Empty strings are treated as `undefined` so that `.optional()` works
 * as expected with placeholder entries in `.env`.
 */

import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  // --- Agent Identity ---------------------------------------------
  AGENT_ID: z.string().uuid(),
  AGENT_NAME: z.string().min(1),
  AGENT_ED25519_KEY_PATH: z.string().min(1),
  AGENT_SOLANA_KEY_PATH: z.string().min(1).optional(),

  // --- Database ---------------------------------------------------
  DATABASE_URL: z.string().url(),

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
