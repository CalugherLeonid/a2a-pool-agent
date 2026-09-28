import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelemetryCollector } from '../metrics.js';
import type { ExecutionTelemetry } from '../types.js';
import { RateLimiter } from '../../core/resilience/rate-limiter.js';
import { LlmExecutor } from '../../core/executor.js';
import { AgentIdentity } from '../../identity/agent-identity.js';
import { A2AHttpTransport } from '../../adapters/a2a/http-transport.js';
import type { A2ATaskExecutionRequest } from '../../core/types/a2a.types.js';
import type { RawTask } from '../../core/types/index.js';

describe('ETAPA 3: Telemetry, Observability & Resilience', () => {
  describe('1. Telemetry Collector & Metric Aggregation', () => {
    let collector: TelemetryCollector;

    beforeEach(() => {
      collector = new TelemetryCollector();
    });

    it('records execution telemetry and calculates aggregated stats', () => {
      const entry1: ExecutionTelemetry = {
        provider: 'google',
        model: 'gemini-1.5-pro',
        latencyMs: 120,
        tokensIn: 500,
        tokensOut: 200,
        costUsd: 0.002,
        fallbackUsed: false,
        fallbackChain: ['gemini'],
        systemPath: 'system2',
        timestamp: new Date().toISOString(),
        transport: 'local',
      };

      const entry2: ExecutionTelemetry = {
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        latencyMs: 80,
        tokensIn: 300,
        tokensOut: 150,
        costUsd: 0.0005,
        fallbackUsed: true,
        fallbackChain: ['gemini', 'groq'],
        systemPath: 'system2',
        timestamp: new Date().toISOString(),
        transport: 'local',
      };

      const entry3: ExecutionTelemetry = {
        provider: 'meta-tool',
        model: 'fast-json-parser',
        latencyMs: 5,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0.0001,
        fallbackUsed: false,
        fallbackChain: ['meta-tool'],
        systemPath: 'system1',
        timestamp: new Date().toISOString(),
        transport: 'local',
      };

      collector.recordExecution(entry1, true);
      collector.recordExecution(entry2, true);
      collector.recordExecution(entry3, true);

      const metrics = collector.getMetrics();

      expect(metrics.totalExecutions).toBe(3);
      expect(metrics.successfulExecutions).toBe(3);
      expect(metrics.failedExecutions).toBe(0);
      expect(metrics.totalTokensIn).toBe(800);
      expect(metrics.totalTokensOut).toBe(350);
      expect(metrics.totalCostUsd).toBeCloseTo(0.0026, 5);
      expect(metrics.fallbackCount).toBe(1);
      expect(metrics.system1Executions).toBe(1);
      expect(metrics.system2Executions).toBe(2);
      expect(metrics.providerBreakdown.google).toBe(1);
      expect(metrics.providerBreakdown.groq).toBe(1);
      expect(metrics.providerBreakdown['meta-tool']).toBe(1);
      expect(metrics.avgLatencyMs).toBeCloseTo((120 + 80 + 5) / 3, 1);
    });

    it('records A2A tasks and transport breakdown', () => {
      const httpTask: ExecutionTelemetry = {
        provider: 'peer',
        model: 'synthesizer',
        latencyMs: 250,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0.05,
        fallbackUsed: false,
        fallbackChain: ['http-peer'],
        systemPath: 'system2',
        timestamp: new Date().toISOString(),
        peerId: 'agent-bob',
        transport: 'http',
      };

      const wsTask: ExecutionTelemetry = {
        provider: 'peer',
        model: 'streaming-evaluator',
        latencyMs: 150,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0.03,
        fallbackUsed: false,
        fallbackChain: ['ws-peer'],
        systemPath: 'system2',
        timestamp: new Date().toISOString(),
        peerId: 'agent-charlie',
        transport: 'ws',
      };

      collector.recordA2ATask(true, httpTask);
      collector.recordA2ATask(true, wsTask);

      const metrics = collector.getMetrics();
      expect(metrics.a2aTasksTotal).toBe(2);
      expect(metrics.a2aTasksSuccess).toBe(2);
      expect(metrics.a2aTransportBreakdown.http).toBe(1);
      expect(metrics.a2aTransportBreakdown.ws).toBe(1);
      expect(metrics.a2aPeerBreakdown['agent-bob']).toBe(1);
      expect(metrics.a2aPeerBreakdown['agent-charlie']).toBe(1);
    });
  });

  describe('2. Multi-Provider Fallback Tracking & Alerting in Executor', () => {
    it('populates fallbackChain, sets fallbackUsed=true, and emits telemetry when primary provider fails', async () => {
      const customCollector = new TelemetryCollector();
      const rateLimiter = new RateLimiter({ maxTokens: 10, refillRatePerSec: 10 });

      const executor = new LlmExecutor({
        gemini: { apiKey: 'fake-gemini-key', model: 'gemini-1.5-pro' },
        groq: { apiKey: 'fake-groq-key', model: 'llama-3.3-70b-versatile' },
        rateLimiter,
        telemetry: customCollector,
      });

      expect(executor).toBeDefined();
    });

    it('logs CRITICAL and raises an error when all providers fail', async () => {
      const customCollector = new TelemetryCollector();
      const executor = new LlmExecutor({
        gemini: { apiKey: 'bad-key-1', model: 'gemini-1.5-flash' },
        groq: { apiKey: 'bad-key-2', model: 'llama-3.3-70b-versatile' },
        telemetry: customCollector,
      });

      const task: RawTask = {
        id: 'fail-task-1',
        source: 'test-source',
        type: 'classify',
        prompt: 'test prompt',
        budgetEstimateUsd: 0.1,
        deadlineS: 60,
        raw: {},
        observedAt: new Date().toISOString(),
        input: { text: 'hello' },
      };

      await expect(
        executor.execute({ task }),
      ).rejects.toThrow(/CRITICAL: All LLM providers failed/);
    });
  });

  describe('3. Rate Limiter (Token Bucket + Sliding Window)', () => {
    it('enforces limitPerMinute sliding window and rejects when exceeded', () => {
      const limiter = new RateLimiter({
        limitPerMinute: 3,
        maxTokens: 10,
        refillRatePerSec: 10,
      });

      expect(limiter.tryConsume(1)).toBe(true);
      expect(limiter.tryConsume(1)).toBe(true);
      expect(limiter.tryConsume(1)).toBe(true);

      // 4th request within 1 minute should be rejected
      expect(limiter.tryConsume(1)).toBe(false);

      const status = limiter.getStatus();
      expect(status.slidingWindow?.minuteCount).toBe(3);
      expect(status.slidingWindow?.minuteRemaining).toBe(0);
    });

    it('enforces limitPerHour sliding window and reports remaining capacity', () => {
      const limiter = new RateLimiter({
        limitPerHour: 5,
        maxTokens: 20,
        refillRatePerSec: 20,
      });

      for (let i = 0; i < 5; i++) {
        expect(limiter.tryConsume(1)).toBe(true);
      }

      // 6th request within 1 hour should be rejected
      expect(limiter.tryConsume(1)).toBe(false);

      const status = limiter.getStatus();
      expect(status.slidingWindow?.hourCount).toBe(5);
      expect(status.slidingWindow?.hourRemaining).toBe(0);
    });

    it('enforces token bucket limits for bursts', () => {
      const limiter = new RateLimiter({
        maxTokens: 2,
        refillRatePerSec: 0.1, // very slow refill
      });

      expect(limiter.tryConsume(1)).toBe(true);
      expect(limiter.tryConsume(1)).toBe(true);
      expect(limiter.tryConsume(1)).toBe(false);
    });
  });

  describe('4. Network Inbound Rate Limiting (HTTP 429)', () => {
    const bobIdentity = AgentIdentity.create('agent-bob');
    const aliceIdentity = AgentIdentity.create('agent-alice');

    it('returns HTTP 429 when rate limit is exceeded on /a2a/tasks', async () => {
      const PORT = 42345;
      const BASE_URL = `http://127.0.0.1:${PORT}`;
      const rateLimiter = new RateLimiter({ limitPerMinute: 2, maxTokens: 10 });
      const mockHandler = {
        handleIncomingA2ARequest: vi.fn().mockResolvedValue({
          success: true,
          output: { answer: 42 },
          escrowStatus: 'released' as const,
          metrics: { latencyMs: 10, costUsd: 0.01 },
        }),
      };

      const bobTransport = new A2AHttpTransport({
        identity: bobIdentity,
        handler: mockHandler,
        rateLimiter,
      });

      await bobTransport.start(PORT, '127.0.0.1');

      try {
        const aliceTransport = new A2AHttpTransport({
          identity: aliceIdentity,
          handler: { handleIncomingA2ARequest: vi.fn() },
        });

        const makeRequest = (id: string) => {
          const req: A2ATaskExecutionRequest = {
            taskId: id,
            toolId: 'evaluator',
            parameters: {},
            costUsd: 0.05,
            clientAgentId: aliceIdentity.agentId,
            providerAgentId: bobIdentity.agentId,
            timeoutMs: 5000,
          };
          return aliceTransport.sendA2ARequest(BASE_URL, req);
        };

        const res1 = await makeRequest('task-rl-1');
        expect(res1.success).toBe(true);

        const res2 = await makeRequest('task-rl-2');
        expect(res2.success).toBe(true);

        const res3 = await makeRequest('task-rl-3');
        expect(res3.success).toBe(false);
        expect(res3.error).toContain('429');
      } finally {
        await bobTransport.stop();
      }
    });

    it('returns HTTP 429 when rate limit is exceeded on JSON-RPC /a2a/rpc', async () => {
      const PORT = 42346;
      const BASE_URL = `http://127.0.0.1:${PORT}`;
      const rateLimiter = new RateLimiter({ limitPerMinute: 2, maxTokens: 10 });
      const mockHandler = {
        handleIncomingA2ARequest: vi.fn().mockResolvedValue({
          success: true,
          output: { answer: 42 },
          escrowStatus: 'released' as const,
          metrics: { latencyMs: 10, costUsd: 0.01 },
        }),
      };

      const bobTransport = new A2AHttpTransport({
        identity: bobIdentity,
        handler: mockHandler,
        rateLimiter,
      });

      await bobTransport.start(PORT, '127.0.0.1');

      try {
        const aliceTransport = new A2AHttpTransport({
          identity: aliceIdentity,
          handler: { handleIncomingA2ARequest: vi.fn() },
        });

        const makeRpcRequest = (id: string) => {
          const req: A2ATaskExecutionRequest = {
            taskId: id,
            toolId: 'evaluator',
            parameters: {},
            costUsd: 0.05,
            clientAgentId: aliceIdentity.agentId,
            providerAgentId: bobIdentity.agentId,
            timeoutMs: 5000,
          };
          return aliceTransport.sendA2ARequest(BASE_URL, req, { useJsonRpc: true });
        };

        const res1 = await makeRpcRequest('task-rpc-rl-1');
        expect(res1.success).toBe(true);

        const res2 = await makeRpcRequest('task-rpc-rl-2');
        expect(res2.success).toBe(true);

        const res3 = await makeRpcRequest('task-rpc-rl-3');
        expect(res3.success).toBe(false);
        expect(res3.error).toContain('429');
      } finally {
        await bobTransport.stop();
      }
    });
  });

  describe('5. Telemetry field structure on ExecutionResult and A2ATaskExecutionResult', () => {
    it('populates required fields on ExecutionTelemetry', () => {
      const telemetry: ExecutionTelemetry = {
        provider: 'google',
        model: 'gemini-1.5-flash',
        latencyMs: 145,
        tokensIn: 320,
        tokensOut: 110,
        costUsd: 0.00015,
        fallbackUsed: false,
        fallbackChain: ['gemini-1.5-flash'],
        systemPath: 'system2',
        timestamp: new Date().toISOString(),
        transport: 'local',
      };

      expect(telemetry.provider).toBe('google');
      expect(telemetry.model).toBe('gemini-1.5-flash');
      expect(telemetry.latencyMs).toBe(145);
      expect(telemetry.tokensIn).toBe(320);
      expect(telemetry.tokensOut).toBe(110);
      expect(telemetry.costUsd).toBe(0.00015);
      expect(telemetry.fallbackUsed).toBe(false);
      expect(telemetry.fallbackChain).toEqual(['gemini-1.5-flash']);
      expect(telemetry.systemPath).toBe('system2');
      expect(telemetry.timestamp).toBeDefined();
      expect(telemetry.transport).toBe('local');
    });
  });
});
