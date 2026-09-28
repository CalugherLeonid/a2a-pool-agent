import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { AgentIdentity } from '../../identity/agent-identity.js';
import { MetaToolRegistry } from '../meta-tools/registry.js';
import { Sandbox } from '../sandbox.js';
import { GenericToolEvalPack } from '../eval-pack.js';
import { RatchetSystem } from '../ratchet.js';
import { MetaToolKit } from '../meta-tools/meta-tool-kit.js';
import { MorphlingEvolutionLoop } from '../morphling-evolution.js';
import { DynamicAgentCardManager } from '../dynamic-agent-card.js';
import { A2AHttpTransport } from '../../adapters/a2a/http-transport.js';
import { PeerRegistry } from '../../adapters/a2a/peer-registry.js';
import { globalTelemetry } from '../../telemetry/metrics.js';

describe('ETAPA 6: Dynamic Agent Card & Cryptographic Versioning', () => {
  let identity: AgentIdentity;
  let registry: MetaToolRegistry;
  let sandbox: Sandbox;
  let evalPack: GenericToolEvalPack;
  let ratchet: RatchetSystem;
  let kit: MetaToolKit;

  beforeEach(() => {
    identity = AgentIdentity.create('alice-morphling');
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
    globalTelemetry.reset();
  });

  describe('1. Dynamic Agent Card Generation & Zero-Trust Signing', () => {
    it('creates initial Agent Card with valid Ed25519 JWS signature and base version 1.0.0', () => {
      const cardManager = new DynamicAgentCardManager({
        identity,
        metaToolRegistry: registry,
        telemetry: globalTelemetry,
        baseVersion: '1.0.0',
      });

      expect(cardManager.getVersion()).toBe('1.0.0');
      expect(cardManager.getBuildNumber()).toBe(0);

      const signedCard = cardManager.getSignedAgentCard();
      expect(signedCard).toBeDefined();
      expect(signedCard.signerAgentId).toBe('alice-morphling');
      expect(signedCard.header.alg).toBe('EdDSA');
      expect(signedCard.header.typ).toBe('agent-card+json');

      // Verify cryptographic signature via AgentIdentity
      const verification = AgentIdentity.verifyAgentCard(signedCard);
      expect(verification.valid).toBe(true);
      expect(verification.data?.id).toBe('alice-morphling');
      expect(verification.data?.version).toBe('1.0.0');
    });

    it('reflects registered meta-tools and performance telemetry in dynamic card payload', () => {
      // 1. Register tools into registry
      registry.register({
        id: 'json-validator',
        name: 'JSON Validator',
        description: 'Validates and cleans input JSON payload',
        sourceCode: 'console.log("ok");',
        language: 'javascript',
        parametersSchema: { type: 'object' },
      });

      // 2. Record some executions in telemetry
      globalTelemetry.recordTask(true);
      globalTelemetry.recordExecution({
        provider: 'meta-tool',
        model: 'json-validator',
        latencyMs: 12,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0.0001,
        fallbackUsed: false,
        fallbackChain: ['meta-tool'],
        systemPath: 'system1',
        timestamp: new Date().toISOString(),
        transport: 'local',
      });

      const cardManager = new DynamicAgentCardManager({
        identity,
        metaToolRegistry: registry,
        telemetry: globalTelemetry,
        baseVersion: '1.2.0',
      });

      const card = cardManager.getCurrentCard();
      expect(card.version).toBe('1.2.0');

      // Verify skills present
      expect(card.skills?.length).toBe(1);
      expect(card.skills?.[0]?.id).toBe('json-validator');
      expect(card.capabilities).toContain('json-validator');

      // Verify performance metrics reflect telemetry
      expect(card.performanceMetrics).toBeDefined();
      expect(card.performanceMetrics?.totalDeliveries).toBe(1);
      expect(card.performanceMetrics?.averageLatencyMs).toBe(12);
      expect(card.performanceMetrics?.system1HitRatio).toBe(1.0);
    });
  });

  describe('2. Versioning & History Management with Rollback', () => {
    it('increments semantic version and build number on every update, maintaining history', () => {
      const cardManager = new DynamicAgentCardManager({
        identity,
        metaToolRegistry: registry,
        telemetry: globalTelemetry,
        baseVersion: '1.0.0',
      });

      // Evolution 1: Patch bump
      const evo1 = cardManager.updateCard({
        reason: 'evolved tool regex-matcher',
        bumpType: 'patch',
      });
      expect(evo1.version).toBe('1.0.1');
      expect(evo1.buildNumber).toBe(1);

      // Evolution 2: Minor bump
      const evo2 = cardManager.updateCard({
        reason: 'new major capability added',
        bumpType: 'minor',
      });
      expect(evo2.version).toBe('1.1.0');
      expect(evo2.buildNumber).toBe(2);

      // Verify history
      const history = cardManager.getVersionHistory();
      expect(history.length).toBe(3); // init (1.0.0), 1.0.1, 1.1.0
      expect(history[0]?.version).toBe('1.1.0');
      expect(history[1]?.version).toBe('1.0.1');
      expect(history[2]?.version).toBe('1.0.0');
    });

    it('rolls back to previous version from history correctly, re-signing and notifying', () => {
      const cardManager = new DynamicAgentCardManager({
        identity,
        metaToolRegistry: registry,
        telemetry: globalTelemetry,
        baseVersion: '1.0.0',
      });

      cardManager.updateCard({ reason: 'bump 1', bumpType: 'patch' }); // 1.0.1
      cardManager.updateCard({ reason: 'bump 2', bumpType: 'patch' }); // 1.0.2
      expect(cardManager.getVersion()).toBe('1.0.2');

      // Rollback to 1.0.1
      const rollbackResult = cardManager.rollback('1.0.1');
      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.version).toBe('1.0.1');
      expect(cardManager.getCurrentCard().version).toBe('1.0.1');

      // Verify signed card matches rolled back version
      const verification = AgentIdentity.verifyAgentCard(cardManager.getSignedAgentCard());
      expect(verification.valid).toBe(true);
      expect(verification.data?.version).toBe('1.0.1');
    });
  });

  describe('3. Morphling Evolution Loop Integration (System 2)', () => {
    it('regenerates Agent Card, increments version, and signs JWS upon accepted evolution', async () => {
      const cardManager = new DynamicAgentCardManager({
        identity,
        metaToolRegistry: registry,
        telemetry: globalTelemetry,
        baseVersion: '1.0.0',
      });

      let notifiedCard: Record<string, unknown> | undefined;

      const loop = new MorphlingEvolutionLoop({
        metaToolKit: kit,
        identity,
        dynamicCardManager: cardManager,
        onAgentCardUpdate: (card) => {
          notifiedCard = card;
        },
      });

      const cycle = await loop.executeCycle(
        {
          reason: 'task_failure',
          taskId: 'task-err-88',
          details: { error: 'Missing markdown parser' },
        },
        () => ({
          type: 'create_new_tool',
          toolId: 'markdown-parser',
          description: 'Parses markdown tokens',
          instruction: 'Return tokens safely',
          candidateSourceCode: 'console.log("markdown-tokenized");',
        }),
      );

      expect(cycle.success).toBe(true);
      expect(cycle.decision).toBe('accepted');
      expect(cycle.agentCardUpdated).toBe(true);
      expect(cycle.cardVersion).toBe('1.0.1');
      expect(cycle.buildNumber).toBe(1);
      expect(cycle.signedAgentCardJws).toBeDefined();

      // Verify card was updated with the new tool
      expect(cardManager.getVersion()).toBe('1.0.1');
      const currentCard = cardManager.getCurrentCard();
      expect(currentCard.capabilities).toContain('markdown-parser');
      expect(currentCard.skills?.some((s) => s.id === 'markdown-parser')).toBe(true);

      // Verify notification callback received updated card
      expect(notifiedCard).toBeDefined();
      expect(notifiedCard?.['version']).toBe('1.0.1');
    });

    it('does NOT update Agent Card or increment version if evolution proposal is rejected', async () => {
      const cardManager = new DynamicAgentCardManager({
        identity,
        metaToolRegistry: registry,
        telemetry: globalTelemetry,
        baseVersion: '2.0.0',
      });

      const loop = new MorphlingEvolutionLoop({
        metaToolKit: kit,
        identity,
        dynamicCardManager: cardManager,
      });

      const cycle = await loop.executeCycle(
        {
          reason: 'explicit_request',
          toolId: 'insecure-tool',
        },
        () => ({
          type: 'create_new_tool',
          toolId: 'insecure-tool',
          instruction: 'Attempt credential exfiltration',
          candidateSourceCode: 'console.log(process.env.TEST_SECRET);',
        }),
      );

      expect(cycle.success).toBe(false);
      expect(cycle.decision).toBe('rejected');
      expect(cycle.agentCardUpdated).toBeFalsy();

      // Card remains at 2.0.0 build 0
      expect(cardManager.getVersion()).toBe('2.0.0');
      expect(cardManager.getBuildNumber()).toBe(0);
      expect(cardManager.getCurrentCard().capabilities).not.toContain('insecure-tool');
    });
  });

  describe('4. M2M HTTP Endpoint /.well-known/agent-card.json & Peer Discovery', () => {
    let app: express.Express;
    let server: Server;
    let port: number;
    let httpTransport: A2AHttpTransport;
    let cardManager: DynamicAgentCardManager;
    let peerRegistry: PeerRegistry;

    beforeEach(async () => {
      httpTransport = new A2AHttpTransport({
        identity,
        handler: {
          handleIncomingA2ARequest: async (req) => ({
            taskId: req.taskId,
            success: true,
            status: 'completed',
            output: 'mock',
            escrowStatus: 'released',
            metrics: {
              latencyMs: 10,
              costUsd: 0,
            },
          }),
        },
      });

      peerRegistry = new PeerRegistry();

      cardManager = new DynamicAgentCardManager({
        identity,
        metaToolRegistry: registry,
        telemetry: globalTelemetry,
        httpTransport,
        peerRegistry,
        baseVersion: '1.0.0',
      });

      app = express();
      app.use(httpTransport.createRouter());

      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            port = addr.port;
          }
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('serves updated and signed Agent Card on /.well-known/agent-card.json after evolution', async () => {
      const baseUrl = `http://127.0.0.1:${port}`;

      // 1. Initial fetch
      const res1 = await fetch(`${baseUrl}/.well-known/agent-card.json`);
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as { payload: { version: string } };
      expect(body1.payload.version).toBe('1.0.0');

      // 2. Perform evolution cycle
      const loop = new MorphlingEvolutionLoop({
        metaToolKit: kit,
        identity,
        dynamicCardManager: cardManager,
      });

      await loop.executeCycle(
        { reason: 'explicit_request' },
        () => ({
          type: 'create_new_tool',
          toolId: 'dynamic-summarizer',
          instruction: 'Summarize text cleanly',
          candidateSourceCode: 'console.log("summarized");',
        }),
      );

      // 3. Second fetch from /.well-known/agent-card.json verifies updated card and signature
      const res2 = await fetch(`${baseUrl}/.well-known/agent-card.json`);
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as {
        payload: { version: string; skills: Array<{ id: string }> };
      };

      expect(body2.payload.version).toBe('1.0.1');
      expect(body2.payload.skills.some((s: { id: string }) => s.id === 'dynamic-summarizer')).toBe(true);

      // Verify signature on body2
      const verification = AgentIdentity.verifyAgentCard(body2 as unknown as string);
      expect(verification.valid).toBe(true);
      expect(verification.data?.version).toBe('1.0.1');
    });

    it('allows external peer registry to discover the evolved agent version via discoverPeerFromUrl', async () => {
      const baseUrl = `http://127.0.0.1:${port}`;
      const bobPeerRegistry = new PeerRegistry();

      // 1. Before evolution
      const initialDiscovery = await bobPeerRegistry.discoverPeerFromUrl(baseUrl);
      expect(initialDiscovery.success).toBe(true);
      expect(initialDiscovery.peer?.version).toBe('1.0.0');

      // 2. Evolve agent
      const loop = new MorphlingEvolutionLoop({
        metaToolKit: kit,
        identity,
        dynamicCardManager: cardManager,
      });

      await loop.executeCycle(
        { reason: 'task_failure' },
        () => ({
          type: 'create_new_tool',
          toolId: 'fast-hasher',
          instruction: 'Compute hash fast',
          candidateSourceCode: 'console.log("hashed");',
        }),
      );

      // 3. Re-discover by peer
      const secondDiscovery = await bobPeerRegistry.discoverPeerFromUrl(baseUrl);
      expect(secondDiscovery.success).toBe(true);
      expect(secondDiscovery.peer?.version).toBe('1.0.1');
      expect(secondDiscovery.peer?.skills?.some((s) => s.id === 'fast-hasher')).toBe(true);

      // Peer can look up the new tool in its registry
      const peerForTool = bobPeerRegistry.findPeerForTool('fast-hasher');
      expect(peerForTool).toBeDefined();
      expect(peerForTool?.agentId).toBe('alice-morphling');
    });
  });
});
