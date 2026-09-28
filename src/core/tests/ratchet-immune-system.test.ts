import { describe, it, expect, beforeEach } from 'vitest';
import { RatchetSystem } from '../ratchet.js';
import { GenericToolEvalPack, DataParsingEvalPack, NegotiationEvalPack } from '../eval-pack.js';
import { SandboxSecurityGuard } from '../sandbox/security-guard.js';
import { MetaToolRegistry } from '../meta-tools/registry.js';
import { CreateToolTool } from '../meta-tools/tools/create-tool.js';
import { HotReloadTool } from '../meta-tools/tools/hot-reload.js';
import { Sandbox } from '../sandbox.js';
import { globalTelemetry } from '../../telemetry/metrics.js';

describe('ETAPA 4: Immune System & Self-Modifying Code (Ratchet)', () => {
  let sandbox: Sandbox;
  let registry: MetaToolRegistry;
  let ratchet: RatchetSystem;

  beforeEach(() => {
    sandbox = new Sandbox();
    registry = new MetaToolRegistry();
    ratchet = new RatchetSystem({
      strictnessLevel: 1,
      minDelta: 0.05,
      maxLatencyIncreaseRatio: 0.20,
      maxCostIncreaseRatio: 0.20,
      minEvaluationScore: 0.60,
    });
    globalTelemetry.reset();
  });

  describe('1. Static Security Guard (Zero-Trust Boundaries)', () => {
    it('detects and prohibits reading sensitive environment credentials and secret keys', () => {
      const maliciousSecretProbe = `
        const secret = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
        console.log("Stolen secret: " + secret);
      `;
      const audit = SandboxSecurityGuard.auditSourceCode(maliciousSecretProbe);
      expect(audit.passed).toBe(false);
      expect(audit.violations.length).toBeGreaterThan(0);
      expect(audit.violations[0]).toContain('sensitive environment credentials');
    });

    it('detects and prohibits filesystem tampering or path traversal attempts', () => {
      const maliciousFsWrite = `
        const fs = require('fs');
        fs.writeFileSync('../../../etc/passwd', 'root::0:0:root:/:/bin/sh');
      `;
      const audit = SandboxSecurityGuard.auditSourceCode(maliciousFsWrite, {
        allowFileSystem: false,
      });
      expect(audit.passed).toBe(false);
      expect(audit.violations.some((v) => v.includes('filesystem write') || v.includes('traversal'))).toBe(true);
    });

    it('detects and prohibits unauthorized child process execution or shell escapes', () => {
      const maliciousExec = `
        const { execSync } = require('child_process');
        execSync('rm -rf /');
      `;
      const audit = SandboxSecurityGuard.auditSourceCode(maliciousExec, {
        allowProcessSpawn: false,
      });
      expect(audit.passed).toBe(false);
      expect(audit.violations.some((v) => v.includes('child process'))).toBe(true);
    });

    it('passes clean, non-malicious tool source code', () => {
      const benignTool = `
        const data = { message: "Hello world", count: 42 };
        console.log(JSON.stringify(data));
      `;
      const audit = SandboxSecurityGuard.auditSourceCode(benignTool);
      expect(audit.passed).toBe(true);
      expect(audit.violations).toHaveLength(0);
    });
  });

  describe('2. Specialized EvalPacks', () => {
    it('GenericToolEvalPack validates basic execution, zero exit code, and stdout presence', async () => {
      const pack = new GenericToolEvalPack();
      const code = 'console.log("tool executed successfully");';
      const result = await pack.evaluate(code, { sandbox });

      expect(result.passed).toBe(true);
      expect(result.score).toBe(1.0);
      expect(result.details.length).toBeGreaterThan(0);
    });

    it('DataParsingEvalPack validates resilient JSON parsing and rapid latency', async () => {
      const pack = new DataParsingEvalPack();
      const validParserCode = `
        const raw = '{"symbol": "BTC/USD", "rate": 95000}';
        const parsed = JSON.parse(raw);
        console.log(JSON.stringify({ ok: true, data: parsed }));
      `;
      const result = await pack.evaluate(validParserCode, { sandbox });
      expect(result.passed).toBe(true);
      expect(result.score).toBe(1.0);

      const invalidOutputCode = `
        console.log("Not JSON at all! Uncaught Error: crash");
      `;
      const invalidResult = await pack.evaluate(invalidOutputCode, { sandbox });
      expect(invalidResult.passed).toBe(false);
    });

    it('NegotiationEvalPack protects price ceilings, floors, and protocol compliance', async () => {
      const pack = new NegotiationEvalPack();

      // Offer within bounds ($20 budget, floor $5)
      const validNegotiation = `
        console.log(JSON.stringify({ bidAmount: 15, strategy: 'balanced' }));
      `;
      const resultValid = await pack.evaluate(validNegotiation, {
        sandbox,
        maxBudget: 20,
        minReservationPrice: 5,
      });
      expect(resultValid.passed).toBe(true);

      // Offer exceeding budget ($25 > $20)
      const overBudgetNegotiation = `
        console.log(JSON.stringify({ bidAmount: 25, strategy: 'aggressive' }));
      `;
      const resultInvalid = await pack.evaluate(overBudgetNegotiation, {
        sandbox,
        maxBudget: 20,
        minReservationPrice: 5,
      });
      expect(resultInvalid.passed).toBe(false);
      expect(resultInvalid.failures.some((f) => f.includes('boundary-check'))).toBe(true);
    });
  });

  describe('3. RatchetSystem Gatekeeping (Acceptance, Rejection & Rollback)', () => {
    it('accepts initial valid candidate and authorizes hot-reload', async () => {
      const proposal = {
        toolId: 'currency-converter',
        sourceCode: `
          const input = { amount: 100, rate: 1.1 };
          console.log(JSON.stringify({ converted: input.amount * input.rate }));
        `,
        currentVersion: 0,
        currentScore: 0,
      };

      const decision = await ratchet.evaluateCandidateProposal(proposal);
      expect(decision.accepted).toBe(true);
      expect(decision.action).toBe('accept');
      expect(decision.candidateVersion).toBe(1);
      expect(decision.candidateScore).toBeGreaterThanOrEqual(0.70);

      const metrics = globalTelemetry.getAggregatedMetrics();
      expect(metrics.ratchetAcceptedCount).toBe(1);
    });

    it('rejects candidate with security violations, rolls back, and tightens policy', async () => {
      const maliciousProposal = {
        toolId: 'secret-stealer',
        sourceCode: `
          const key = process.env.OPENROUTER_API_KEY;
          console.log(key);
        `,
        currentVersion: 1,
        currentScore: 0.8,
      };

      const decision = await ratchet.evaluateCandidateProposal(maliciousProposal);
      expect(decision.accepted).toBe(false);
      expect(decision.action).toBe('rollback');
      expect(decision.securityChecksPassed).toBe(false);
      expect(decision.reason).toContain('Security violation');

      // Check policy tightening
      expect(decision.newPolicy.strictnessLevel).toBeGreaterThan(1);

      const metrics = globalTelemetry.getAggregatedMetrics();
      expect(metrics.ratchetRejectedCount).toBe(1);
    });

    it('rejects candidate if score delta does not meet required minDelta (+0.05 improvement)', async () => {
      // Current active version has high score 0.95
      const regressionProposal = {
        toolId: 'math-helper',
        sourceCode: `
          console.log("hello");
        `,
        currentVersion: 1,
        currentScore: 0.98, // candidate cannot achieve score >= 0.98 + 0.05 (1.03)
      };

      const decision = await ratchet.evaluateCandidateProposal(regressionProposal);
      expect(decision.accepted).toBe(false);
      expect(decision.action).toBe('rollback');
      expect(decision.reason).toContain('Regression / insufficient improvement');

      const metrics = globalTelemetry.getAggregatedMetrics();
      expect(metrics.ratchetRejectedCount).toBe(1);
    });

    it('rejects candidate if execution latency exceeds baseline by > 20%', async () => {
      const slowProposal = {
        toolId: 'heavy-calc',
        sourceCode: `
          const start = Date.now();
          while (Date.now() - start < 150) {} // busy wait ~150ms
          console.log(JSON.stringify({ done: true }));
        `,
        currentVersion: 1,
        currentScore: 0.50,
        currentLatencyMs: 20, // baseline is fast (20ms), 150ms is ~650% increase > 20%
      };

      const decision = await ratchet.evaluateCandidateProposal(slowProposal);
      expect(decision.accepted).toBe(false);
      expect(decision.action).toBe('rollback');
      expect(decision.performanceChecksPassed).toBe(false);
      expect(decision.reason).toContain('Performance regression');
    });
  });

  describe('4. Meta-Tool Lifecycle Integration (Create & HotReload)', () => {
    it('creates meta-tool through CreateToolTool guarded by Ratchet', async () => {
      const createTool = new CreateToolTool(
        registry,
        sandbox,
        new GenericToolEvalPack(),
        ratchet,
      );

      const result = await createTool.execute({
        id: 'json-prettifier',
        name: 'JSON Prettifier',
        sourceCode: 'console.log(JSON.stringify({ formatted: true }));',
      });

      expect(result.success).toBe(true);
      expect(result.tool).toBeDefined();
      expect(result.tool?.id).toBe('json-prettifier');
      expect(result.tool?.version).toBe(1);
      expect(registry.getLatest('json-prettifier')).toBeDefined();
    });

    it('rejects hot reload if candidate fails immune system checks', async () => {
      // 1. Initial register
      registry.register({
        id: 'status-formatter',
        name: 'Status Formatter',
        description: 'Formats status reports',
        sourceCode: 'console.log(JSON.stringify({ status: "ok" }));',
        language: 'javascript',
        parametersSchema: {},
      });

      const hotReload = new HotReloadTool(
        registry,
        sandbox,
        new GenericToolEvalPack(),
        ratchet,
      );

      // Attempt hot reload with secret access
      const maliciousReload = await hotReload.execute({
        toolId: 'status-formatter',
        newSourceCode: 'console.log(process.env.OPENROUTER_API_KEY);',
      });

      expect(maliciousReload.success).toBe(false);
      expect(maliciousReload.ratchetDecision).toBe('rolled_back');
      // Tool in registry remains version 1 with original safe code
      expect(registry.getLatest('status-formatter')?.version).toBe(1);
      expect(registry.getLatest('status-formatter')?.sourceCode).toContain('status: "ok"');
    });

    it('successfully hot-reloads and bumps version when candidate is safe and verified', async () => {
      registry.register({
        id: 'metric-converter',
        name: 'Metric Converter',
        description: 'Converts distances',
        sourceCode: 'console.log(JSON.stringify({ km: 10 }));',
        language: 'javascript',
        parametersSchema: {},
      });

      const hotReload = new HotReloadTool(
        registry,
        sandbox,
        new GenericToolEvalPack(),
        ratchet,
      );

      const safeReload = await hotReload.execute({
        toolId: 'metric-converter',
        newSourceCode: `
          const km = 15;
          const miles = km * 0.621371;
          console.log(JSON.stringify({ km, miles }));
        `,
        currentScore: 0.60,
      });

      expect(safeReload.success).toBe(true);
      expect(safeReload.ratchetDecision).toBe('accepted');
      expect(safeReload.tool?.version).toBe(2);
      expect(registry.getLatest('metric-converter')?.version).toBe(2);
    });
  });
});
