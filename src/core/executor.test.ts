import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmExecutor, RateLimitExceededError } from './executor.js';
import { RateLimiter } from './resilience/rate-limiter.js';
import { TelemetryCollector } from '../telemetry/metrics.js';
import { calculateTokenCostUsd } from './cost-estimator.js';
import type { RawTask } from './types/index.js';

// Mock LLM providers
vi.mock('./llm/gemini.js', () => ({
  callGemini: vi.fn(),
}));
vi.mock('./llm/groq.js', () => ({
  callGroq: vi.fn(),
}));
vi.mock('./llm/openrouter.js', () => ({
  callOpenRouter: vi.fn(),
}));

import { callGemini } from './llm/gemini.js';
import { callGroq } from './llm/groq.js';
import { callOpenRouter } from './llm/openrouter.js';

describe('Faza 7: LlmExecutor Integration', () => {
  const dummyTask: RawTask = {
    id: 'task-123',
    source: 'okx-market',
    type: 'extract',
    prompt: 'Extract dates from text',
    outputSchema: { type: 'object', properties: { dates: { type: 'array' } } },
    input: { text: '2026-09-21' },
    budgetEstimateUsd: 1.0,
    deadlineS: 60,
    raw: {},
    observedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Rate Limiting Preventiv', () => {
    it('aruncă RateLimitExceededError dacă bucket-ul este epuizat și expiră timeout-ul', async () => {
      const exhaustedLimiter = new RateLimiter(0, 0); // zero tokens, zero refill
      const executor = new LlmExecutor({
        gemini: { apiKey: 'test-key', model: 'gemini-1.5-flash' },
        rateLimiter: exhaustedLimiter,
        rateLimitTimeoutMs: 100,
      });

      await expect(
        executor.execute({ task: dummyTask, maxTokens: 100 }),
      ).rejects.toThrowError(RateLimitExceededError);
    });

    it('consumă token din rate limiter când există disponibilitate', async () => {
      const limiter = new RateLimiter(2, 0);
      vi.mocked(callGemini).mockResolvedValueOnce({
        text: JSON.stringify({ dates: ['2026-09-21'] }),
        model: 'gemini-1.5-flash',
        provider: 'google',
        tokensIn: 100,
        tokensOut: 50,
        finishReason: 'stop',
      });

      const executor = new LlmExecutor({
        gemini: { apiKey: 'test-key', model: 'gemini-1.5-flash' },
        rateLimiter: limiter,
      });

      const res = await executor.execute({ task: dummyTask });
      expect(res.modelUsed).toBe('gemini-1.5-flash');
      expect(limiter.getAvailableTokens()).toBe(1); // 1 token consumed
    });
  });

  describe('2. Telemetrie & Cost Tracking per Execuție', () => {
    it('calculează costUsd, măsoară latencyMs și atașează metricile în ExecutionResult', async () => {
      const telemetry = new TelemetryCollector();
      vi.mocked(callGemini).mockResolvedValueOnce({
        text: JSON.stringify({ dates: ['2026-09-21'] }),
        model: 'gemini-1.5-flash',
        provider: 'google',
        tokensIn: 2000,
        tokensOut: 1000,
        finishReason: 'stop',
      });

      const executor = new LlmExecutor({
        gemini: { apiKey: 'test-key', model: 'gemini-1.5-flash' },
        telemetry,
      });

      const result = await executor.execute({ task: dummyTask });

      // Metric checks
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.tokensIn).toBe(2000);
      expect(result.tokensOut).toBe(1000);
      expect(result.modelUsed).toBe('gemini-1.5-flash');
      expect(result.model).toBe('gemini-1.5-flash');

      const expectedCost = calculateTokenCostUsd('gemini-1.5-flash', 2000, 1000, 'google');
      expect(result.costUsd).toBe(expectedCost);
      expect(result.costUsd).toBeGreaterThan(0);

      // Verify telemetry collected the latency
      const prometheusOutput = telemetry.getPrometheusFormat();
      expect(prometheusOutput).toContain('agent_llm_latency_ms');
    });
  });

  describe('3. Logare & Alerting pe Fallback Chain', () => {
    it('trece la următorul provider când primul eșuează și reușește cu fallback', async () => {
      vi.mocked(callGemini).mockRejectedValueOnce(new Error('Gemini quota exhausted'));
      vi.mocked(callGroq).mockResolvedValueOnce({
        text: JSON.stringify({ dates: ['2026-09-21'] }),
        model: 'llama-3.1-70b-versatile',
        provider: 'groq',
        tokensIn: 1500,
        tokensOut: 400,
        finishReason: 'stop',
      });

      const executor = new LlmExecutor({
        gemini: { apiKey: 'gem-key', model: 'gemini-1.5-flash' },
        groq: { apiKey: 'groq-key', model: 'llama-3.1-70b-versatile' },
      });

      const result = await executor.execute({ task: dummyTask });

      expect(callGemini).toHaveBeenCalledTimes(1);
      expect(callGroq).toHaveBeenCalledTimes(1);
      expect(result.provider).toBe('groq');
      expect(result.modelUsed).toBe('llama-3.1-70b-versatile');
    });

    it('emite eroare critică dacă întregul lanț de fallback eșuează', async () => {
      vi.mocked(callGemini).mockRejectedValueOnce(new Error('Gemini down'));
      vi.mocked(callGroq).mockRejectedValueOnce(new Error('Groq 500 internal error'));
      vi.mocked(callOpenRouter).mockRejectedValueOnce(new Error('OpenRouter timeout'));

      const executor = new LlmExecutor({
        gemini: { apiKey: 'gem-key', model: 'gemini-1.5-flash' },
        groq: { apiKey: 'groq-key', model: 'llama-3.1-8b-instant' },
        openrouter: { apiKey: 'or-key', model: 'deepseek/deepseek-chat' },
      });

      await expect(executor.execute({ task: dummyTask })).rejects.toThrow(
        /CRITICAL: All LLM providers failed/,
      );
    });
  });
});
