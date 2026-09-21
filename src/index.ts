/**
 * Entrypoint.
 *
 * Wires everything together:
 *   - Signer (Ed25519 identity)
 *   - Economics config (thresholds, delay floor, model router)
 *   - Adapter registry (railway receives the signer for pubkey publish)
 *   - Learning store (scoped by AGENT_ENVIRONMENT)
 *   - Budget guard (hydrated from today's learning events)
 *   - Agent Core (orchestrator)
 */

import { env } from './config/env.js';
import { loadEconomics, thresholdsFor } from './config/economics.js';
import { createLogger } from './observability/logger.js';
import { AdapterRegistry } from './core/registry.js';
import { RailwayAdapter } from './adapters/railway/index.js';
import { MockAdapter } from './adapters/mock/index.js';
import { AgentCore } from './core/agent.js';
import { TriageEngine } from './core/triage.js';
import { LlmExecutor, type Executor } from './core/executor.js';
import { StubExecutor } from './core/stub-executor.js';
import { QualityChecker } from './core/quality.js';
import { Ledger } from './core/ledger.js';
import { LearningStore } from './core/learning.js';
import { BudgetGuard } from './core/budget.js';
import {
  LearningBackedSuccessProbabilityProvider,
  LearningBackedCostEstimator,
} from './core/learning-providers.js';
import { createModelRouter } from './core/model-router.js';
import { loadSignerFromPemPath, type Signer } from './identity/ed25519.js';
import { closePool } from './persistence/pool.js';
import { createDashboardServer } from './server/dashboard.js';

const log = createLogger('main');

function pickExecutor(): Executor {
  const gemini = env.GEMINI_API_KEY
    ? { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }
    : undefined;
  const groq = env.GROQ_API_KEY
    ? { apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL }
    : undefined;
  const openrouter = env.OPENROUTER_API_KEY
    ? { apiKey: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL }
    : undefined;

  if (!gemini && !groq && !openrouter) {
    log.warn('no LLM API key found — using StubExecutor');
    return new StubExecutor();
  }

  log.info(
    {
      gemini: !!gemini,
      groq: !!groq,
      openrouter: !!openrouter,
      geminiModel: gemini?.model,
      groqModel: groq?.model,
      openrouterModel: openrouter?.model,
    },
    'LLM executor configured',
  );

  return new LlmExecutor({ gemini, groq, openrouter });
}

async function main(): Promise<void> {
  log.info(
    {
      agentId: env.AGENT_ID,
      agentName: env.AGENT_NAME,
      nodeEnv: env.NODE_ENV,
      agentEnvironment: env.AGENT_ENVIRONMENT,
    },
    'a2a-pool-agent starting',
  );

  // --- Signing key ---
  let signer: Signer;
  try {
    signer = loadSignerFromPemPath(env.AGENT_ED25519_KEY_PATH);
  } catch (err) {
    log.error(
      { path: env.AGENT_ED25519_KEY_PATH, err },
      'failed to load Ed25519 key — run: node scripts/generate-key.mjs',
    );
    process.exit(1);
  }
  log.info({ pubkey: signer.pubkeyPem().split('\n')[0] }, 'signer loaded');

  // --- Economics ---
  const economics = loadEconomics();
  log.info(
    {
      delayFloorHours: economics.delay_floor_hours,
      modelRouterMode: economics.model_router.mode,
      fixedModel: economics.model_router.fixed_model,
      learningWindowDays: economics.learning_window_days,
    },
    'economics loaded',
  );

  // --- Adapter registry ---
  const registry = new AdapterRegistry();
  registry.registerFactory(
    'railway',
    (config) =>
      new RailwayAdapter(config, signer, {
        pollIntervalMs: env.POLL_INTERVAL_MS,
      }),
  );
  registry.registerFactory(
    'mock',
    (config) =>
      new MockAdapter(config, { pollIntervalMs: env.POLL_INTERVAL_MS }),
  );

  await registry.loadConfigs();
  await registry.initAll();
  log.info({ adapters: registry.health() }, 'adapters ready');

  if (registry.ids().length === 0) {
    log.warn('no adapters active — check config/adapters/*.json and .env');
    return;
  }

  // --- Learning store (scoped by environment) ---
  const learning = new LearningStore(env.AGENT_ENVIRONMENT);

  // --- Model router ---
  const modelRouter = createModelRouter({
    mode: economics.model_router.mode,
    fixedModel: economics.model_router.fixed_model,
    store: learning,
    windowDays: economics.learning_window_days,
    minSamples: economics.model_router.min_samples_for_learning,
  });

  // --- Success probability: learning-backed ---
  const successProb = new LearningBackedSuccessProbabilityProvider(
    learning,
    economics.success_probability_prior,
    economics.learning_window_days,
    economics.min_learning_events,
  );

  // --- Cost estimator: learning-backed ---
  const costEstimator = new LearningBackedCostEstimator(
    learning,
    economics.learning_window_days,
    economics.min_learning_events,
  );

  // --- Triage ---
  const primaryAdapterId = registry.ids()[0] ?? 'mock';
  const thresholds = thresholdsFor(economics, primaryAdapterId);
  const triage = new TriageEngine({
    thresholds,
    successProb,
    modelRouter,
    costEstimator,
    defaultGasCostUsd: economics.estimated_gas_cost_usd,
    delayFloorHours: economics.delay_floor_hours,
  });

  // --- Budget guard (hard gate) ---
  const budget = new BudgetGuard({
    dailyCapUsd: env.DAILY_BUDGET_USD,
    store: learning,
  });
  await budget.hydrate();

  const executor = pickExecutor();
  const quality = new QualityChecker();
  const ledger = new Ledger();

  // --- Agent Core ---
  const core = new AgentCore({
    registry,
    signer,
    triage,
    executor,
    quality,
    ledger,
    learning,
    budget,
    agentId: env.AGENT_ID,
    workerId: env.AGENT_NAME,
    delayFloorHours: economics.delay_floor_hours,
  });

  // --- Dashboard HTTP Server (Port 3000) ---
  const startTime = new Date();
  const server = createDashboardServer({
    signer,
    registry,
    budget,
    ledger,
    learning,
    economics,
    startTime,
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutdown signal received');
    server.close();
    await core.stop();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await core.run();
}

main().catch((err: unknown) => {
  log.error({ err }, 'fatal');
  process.exit(1);
});
