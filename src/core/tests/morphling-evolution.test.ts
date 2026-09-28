import { describe, it, expect, beforeEach } from 'vitest';
import { MetaToolRegistry } from '../meta-tools/registry.js';
import { ReadSourceTool } from '../meta-tools/tools/read-source.js';
import { EditSourceTool } from '../meta-tools/tools/edit-source.js';
import { CreateToolTool } from '../meta-tools/tools/create-tool.js';
import { HotReloadTool } from '../meta-tools/tools/hot-reload.js';
import { MetaToolKit } from '../meta-tools/meta-tool-kit.js';
import { MorphlingEvolutionLoop } from '../morphling-evolution.js';
import { RatchetSystem } from '../ratchet.js';
import { GenericToolEvalPack } from '../eval-pack.js';
import { Sandbox } from '../sandbox.js';
import { AgentIdentity } from '../../identity/agent-identity.js';
import { globalTelemetry } from '../../telemetry/metrics.js';

describe('ETAPA 5: Meta-Tools Complete & Morphling Evolution Loop (System 2)', () => {
  let registry: MetaToolRegistry;
  let sandbox: Sandbox;
  let evalPack: GenericToolEvalPack;
  let ratchet: RatchetSystem;
  let kit: MetaToolKit;
  let identity: AgentIdentity;

  beforeEach(() => {
    registry = new MetaToolRegistry();
    sandbox = new Sandbox();
    evalPack = new GenericToolEvalPack();
    ratchet = new RatchetSystem({
      strictnessLevel: 1,
      minDelta: 0.05,
      maxLatencyIncreaseRatio: 0.2,
      maxCostIncreaseRatio: 0.2,
      minEvaluationScore: 0.6,
    });
    kit = new MetaToolKit({
      registry,
      sandbox,
      evalPack,
      ratchetSystem: ratchet,
    });
    identity = AgentIdentity.create('morphling-agent-01');
    globalTelemetry.reset();
  });

  describe('1. Individual Meta-Tools', () => {
    describe('read_source', () => {
      it('reads source code of registered tools from registry', () => {
        registry.register({
          id: 'test-tool-1',
          name: 'Test Tool',
          description: 'A tool for testing',
          sourceCode: 'console.log("hello world");',
          language: 'javascript',
          parametersSchema: {},
        });

        const reader = new ReadSourceTool(registry);
        const result = reader.execute({ toolId: 'test-tool-1' });

        expect(result.success).toBe(true);
        expect(result.sourceCode).toBe('console.log("hello world");');
        expect(result.tool?.id).toBe('test-tool-1');
      });

      it('reads allowed local source files within allowed project directories', () => {
        const reader = new ReadSourceTool(registry);
        const result = reader.execute({ path: 'src/core/meta-tools/types.ts' });

        expect(result.success).toBe(true);
        expect(result.sourceCode).toContain('MetaToolDefinition');
      });

      it('strictly forbids access to sensitive keys and files outside permitted directories', () => {
        const reader = new ReadSourceTool(registry);

        // Sensitive key file
        const envAttempt = reader.execute({ path: '.env' });
        expect(envAttempt.success).toBe(false);
        expect(envAttempt.error).toContain('forbidden');

        // Path traversal out of workspace
        const traversalAttempt = reader.execute({ path: '../../etc/passwd' });
        expect(traversalAttempt.success).toBe(false);
        expect(traversalAttempt.error).toContain('forbidden');

        // Forbidden directory
        const unpermittedDir = reader.execute({ path: 'package.json' });
        expect(unpermittedDir.success).toBe(false);
        expect(unpermittedDir.error).toContain('outside permitted source directories');
      });
    });

    describe('edit_source', () => {
      it('proposes modifications with unified diff and NEVER applies them directly', () => {
        registry.register({
          id: 'summarizer',
          name: 'Summarizer',
          description: 'Summarizes text',
          sourceCode: 'const text = "sample";\nconsole.log(text);',
          language: 'javascript',
          parametersSchema: {},
        });

        const editor = new EditSourceTool(registry);
        const editResult = editor.execute({
          toolId: 'summarizer',
          instruction: 'Print uppercase text',
          replacement: {
            search: 'console.log(text);',
            replace: 'console.log(text.toUpperCase());',
          },
        });

        expect(editResult.success).toBe(true);
        expect(editResult.applied).toBe(false); // Invariant: edit_source never writes directly!
        expect(editResult.proposedCode).toContain('text.toUpperCase()');
        expect(editResult.diff).toContain('+console.log(text.toUpperCase());');
        expect(editResult.diff).toContain('-console.log(text);');

        // The original tool in registry remains completely unmodified
        expect(registry.getLatest('summarizer')?.sourceCode).toBe(
          'const text = "sample";\nconsole.log(text);',
        );
      });

      it('runs SandboxSecurityGuard static audit on proposed code and rejects malicious edits', () => {
        registry.register({
          id: 'benign-tool',
          name: 'Benign Tool',
          description: 'Safe tool',
          sourceCode: 'console.log("safe");',
          language: 'javascript',
          parametersSchema: {},
        });

        const editor = new EditSourceTool(registry);
        const maliciousEdit = editor.execute({
          toolId: 'benign-tool',
          instruction: 'Extract process env secrets',
          proposedCode: 'console.log(process.env.OPENROUTER_API_KEY);',
        });

        expect(maliciousEdit.success).toBe(false);
        expect(maliciousEdit.securityChecksPassed).toBe(false);
        expect(maliciousEdit.securityViolations.length).toBeGreaterThan(0);
        expect(maliciousEdit.applied).toBe(false);
      });
    });

    describe('create_tool', () => {
      it('validates proposed tool through SandboxSecurityGuard, EvalPack, and Ratchet', async () => {
        const creator = new CreateToolTool(registry, sandbox, evalPack, ratchet);

        const safeCreation = await creator.execute({
          id: 'string-reverser',
          name: 'String Reverser',
          description: 'Reverses string',
          sourceCode: 'console.log("olleh");',
        });

        expect(safeCreation.success).toBe(true);
        expect(safeCreation.tool?.id).toBe('string-reverser');
        expect(safeCreation.tool?.version).toBe(1);
        expect(registry.getLatest('string-reverser')).toBeDefined();
      });

      it('blocks creation of unsafe or faulty code', async () => {
        const creator = new CreateToolTool(registry, sandbox, evalPack, ratchet);

        const maliciousCreation = await creator.execute({
          id: 'evil-tool',
          name: 'Evil Tool',
          sourceCode: 'const child = require("child_process"); child.execSync("whoami");',
        });

        expect(maliciousCreation.success).toBe(false);
        expect(maliciousCreation.error).toContain('Immune system rejected');
        expect(registry.getLatest('evil-tool')).toBeUndefined();
      });
    });

    describe('hot_reload', () => {
      it('re-evaluates updated code and bumps version only when accepted by Ratchet', async () => {
        registry.register({
          id: 'counter',
          name: 'Counter',
          description: 'Counts items',
          sourceCode: 'console.log(JSON.stringify({ count: 1 }));',
          language: 'javascript',
          parametersSchema: {},
        });

        const reloader = new HotReloadTool(registry, sandbox, evalPack, ratchet);

        const reloadResult = await reloader.execute({
          toolId: 'counter',
          newSourceCode: 'console.log(JSON.stringify({ count: 2 }));',
          currentScore: 0.6,
        });

        expect(reloadResult.success).toBe(true);
        expect(reloadResult.ratchetDecision).toBe('accepted');
        expect(reloadResult.tool?.version).toBe(2);
        expect(registry.getLatest('counter')?.version).toBe(2);
      });
    });
  });

  describe('2. System 1 vs System 2 Access Control Boundaries', () => {
    it('allows System 2 to invoke read_source, edit_source, create_tool, and hot_reload', async () => {
      // System 2 invocation succeeds
      const readResult = kit.readSource({ path: 'src/core/meta-tools/types.ts' }, 'system2');
      expect(readResult.success).toBe(true);

      const createResult = await kit.createTool(
        {
          id: 'sys2-tool',
          name: 'System 2 Tool',
          sourceCode: 'console.log("created by sys2");',
        },
        'system2',
      );
      expect(createResult.success).toBe(true);
    });

    it('STRICTLY BLOCKS System 1 from calling any meta-tool', async () => {
      expect(() => {
        kit.readSource({ path: 'src/core/meta-tools/types.ts' }, 'system1');
      }).toThrow(/reserved for System 2/);

      expect(() => {
        kit.editSource(
          {
            path: 'src/core/meta-tools/types.ts',
            instruction: 'noop',
            proposedCode: 'noop',
          },
          'system1',
        );
      }).toThrow(/reserved for System 2/);

      await expect(
        kit.createTool(
          {
            id: 'unauthorized-tool',
            name: 'Unauthorized Tool',
            sourceCode: 'console.log(1);',
          },
          'system1',
        ),
      ).rejects.toThrow(/reserved for System 2/);

      await expect(
        kit.hotReload(
          {
            toolId: 'sys2-tool',
            newSourceCode: 'console.log(2);',
          },
          'system1',
        ),
      ).rejects.toThrow(/reserved for System 2/);
    });
  });

  describe('3. Morphling Evolution Loop (End-to-End)', () => {
    it('executes self-modification loop on task failure trigger, creating tool and updating Agent Card', async () => {
      let updatedCard: Record<string, unknown> | undefined;

      const loop = new MorphlingEvolutionLoop({
        metaToolKit: kit,
        identity,
        onAgentCardUpdate: (card) => {
          updatedCard = card;
        },
      });

      const cycle = await loop.executeCycle(
        {
          reason: 'task_failure',
          taskId: 'task-failed-001',
          details: { error: 'Schema validation mismatch on json parsing' },
        },
        () => ({
          type: 'create_new_tool',
          toolId: 'json-normalizer',
          description: 'Parses and normalizes input data',
          instruction: 'Ensure input string parses to valid JSON without crashing',
          candidateSourceCode: `
            const input = '{"status":"success","normalized":true}';
            console.log(input);
          `,
        }),
      );

      expect(cycle.success).toBe(true);
      expect(cycle.decision).toBe('accepted');
      expect(cycle.tool?.id).toBe('json-normalizer');
      expect(cycle.tool?.version).toBe(1);
      expect(cycle.agentCardUpdated).toBe(true);
      expect(cycle.signedAgentCardJws).toBeDefined();

      // Verify Agent Card was signed and updated
      expect(updatedCard).toBeDefined();
      expect(updatedCard?.agentId).toBe(identity.agentId);

      // Verify Telemetry counters recorded
      const metrics = globalTelemetry.getAggregatedMetrics();
      expect(metrics.evolutionAttemptedCount).toBe(1);
      expect(metrics.evolutionAcceptedCount).toBe(1);
      expect(metrics.evolutionRejectedCount).toBe(0);

      const prometheus = globalTelemetry.getPrometheusFormat();
      expect(prometheus).toContain('agent_evolution_attempted_total 1');
      expect(prometheus).toContain('agent_evolution_accepted_total 1');
    });

    it('rejects evolution candidate if proposed code fails Ratchet or security, preserving current tool', async () => {
      // 1. Setup initial version
      registry.register({
        id: 'stable-tool',
        name: 'Stable Tool',
        description: 'Stable tool v1',
        sourceCode: 'console.log("v1-ok");',
        language: 'javascript',
        parametersSchema: {},
      });

      const loop = new MorphlingEvolutionLoop({
        metaToolKit: kit,
        identity,
      });

      // 2. Propose evolution with security violation
      const cycle = await loop.executeCycle(
        {
          reason: 'explicit_request',
          toolId: 'stable-tool',
        },
        () => ({
          type: 'edit_existing_tool',
          toolId: 'stable-tool',
          instruction: 'Extract process credentials',
          candidateSourceCode: 'console.log(process.env.GEMINI_API_KEY);',
        }),
      );

      expect(cycle.success).toBe(false);
      expect(cycle.decision).toBe('rejected');
      expect(cycle.error).toContain('security');

      // Previous version in registry remains unmodified
      expect(registry.getLatest('stable-tool')?.version).toBe(1);
      expect(registry.getLatest('stable-tool')?.sourceCode).toBe('console.log("v1-ok");');

      // Verify Telemetry
      const metrics = globalTelemetry.getAggregatedMetrics();
      expect(metrics.evolutionAttemptedCount).toBe(1);
      expect(metrics.evolutionAcceptedCount).toBe(0);
      expect(metrics.evolutionRejectedCount).toBe(1);

      const prometheus = globalTelemetry.getPrometheusFormat();
      expect(prometheus).toContain('agent_evolution_rejected_total 1');
    });
  });
});
