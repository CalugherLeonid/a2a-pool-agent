import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { WebSocket as WsNodeClient } from 'ws';
import { AgentIdentity } from '../../../identity/agent-identity.js';
import {
  generateAgentCard,
  generateSignedAgentCard,
} from '../agent-card.js';
import { PeerRegistry } from '../peer-registry.js';
import { A2AHttpTransport, type A2ATaskHandler } from '../http-transport.js';
import { A2AWsTransport } from '../ws-transport.js';
import { A2AWsClient } from '../ws-client.js';
import type {
  A2ATaskExecutionRequest,
  A2ATaskExecutionResult,
} from '../../../core/types/a2a.types.js';

describe('ETAPA 2: Network Adapters (Real M2M Transport)', () => {
  const aliceIdentity = AgentIdentity.create('agent-alice');
  const bobIdentity = AgentIdentity.create('agent-bob');

  describe('Agent Card & JWS Cryptographic Publishing', () => {
    it('generates a valid standardized Agent Card with endpoints and identity', () => {
      const card = generateAgentCard({
        agentId: 'agent-alice',
        name: 'Alice Worker',
        publicKeyPem: aliceIdentity.getPublicKeyPem(),
        publicKeyHex: aliceIdentity.getPublicKeyHex(),
        capabilities: ['data-processing', 'meta-tools'],
        endpoints: {
          http: 'http://127.0.0.1:4001/a2a',
          ws: 'ws://127.0.0.1:4001/a2a/ws',
          wellKnown: 'http://127.0.0.1:4001/.well-known/agent-card.json',
        },
      });

      expect(card.id).toBe('agent-alice');
      expect(card.schemaVersion).toBe('1.0.0');
      expect(card.endpoints?.http).toBe('http://127.0.0.1:4001/a2a');
      expect(card.identity.type).toBe('ed25519');
      expect(card.identity.publicKeyPem).toBe(aliceIdentity.getPublicKeyPem());
    });

    it('creates a cryptographically signed Agent Card (JWS) and verifies it', () => {
      const signedCard = generateSignedAgentCard(aliceIdentity, {
        name: 'Alice Worker',
        capabilities: ['meta-tools', 'text-summarization'],
      });

      expect(signedCard.header.alg).toBe('EdDSA');
      expect(signedCard.signerAgentId).toBe('agent-alice');
      expect(signedCard.compactJws.split('.').length).toBe(3);

      const verification = AgentIdentity.verifyAgentCard(signedCard);
      expect(verification.valid).toBe(true);
      expect((verification.data as any).id).toBe('agent-alice');
    });
  });

  describe('Discovery & PeerRegistry', () => {
    it('registers a peer from a valid signed Agent Card', () => {
      const registry = new PeerRegistry();
      const signedCard = generateSignedAgentCard(bobIdentity, {
        name: 'Bob Synthesizer',
        capabilities: ['code-synthesis', 'json-transformation'],
        endpoints: {
          http: 'http://127.0.0.1:4002/a2a',
          wellKnown: 'http://127.0.0.1:4002/.well-known/agent-card.json',
        },
      });

      const outcome = registry.registerPeer(signedCard);
      expect(outcome.success).toBe(true);
      expect(outcome.peer?.agentId).toBe('agent-bob');
      expect(outcome.peer?.endpoints.http).toBe('http://127.0.0.1:4002/a2a');

      expect(registry.hasPeer('agent-bob')).toBe(true);
      expect(registry.getPeer('agent-bob')?.name).toBe('Bob Synthesizer');
    });

    it('rejects peer registration if Agent Card cryptographic signature is invalid or tampered', () => {
      const registry = new PeerRegistry();
      const signedCard = generateSignedAgentCard(bobIdentity, {
        name: 'Bob Synthesizer',
        endpoints: {
          http: 'http://127.0.0.1:4002/a2a',
          wellKnown: 'http://127.0.0.1:4002/.well-known/agent-card.json',
        },
      });

      // Attacker tampers with signature and compact JWS
      signedCard.signature = 'ed25519:deadbeef000000000000' as any;
      signedCard.compactJws = signedCard.compactJws.slice(0, -10) + 'deadbeef';

      const outcome = registry.registerPeer(signedCard);
      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain('signature verification failed');
      expect(registry.hasPeer('agent-bob')).toBe(false);
    });

    it('queries registered peers by capability and tool', () => {
      const registry = new PeerRegistry();
      const signedCard = generateSignedAgentCard(bobIdentity, {
        name: 'Bob',
        capabilities: ['meta-tools', 'code-synthesis'],
        skills: [
          { id: 'smart-parser', name: 'Smart Parser', description: 'Parses AST' },
        ],
        endpoints: {
          http: 'http://127.0.0.1:4002/a2a',
          wellKnown: 'http://127.0.0.1:4002/.well-known/agent-card.json',
        },
      });
      registry.registerPeer(signedCard);

      const peersWithSynthesis = registry.findPeersByCapability('code-synthesis');
      expect(peersWithSynthesis.length).toBe(1);
      expect(peersWithSynthesis[0]!.agentId).toBe('agent-bob');

      const peerForTool = registry.findPeerForTool('smart-parser');
      expect(peerForTool?.agentId).toBe('agent-bob');
    });
  });

  describe('HTTP Transport (REST + JSON-RPC)', () => {
    let bobTransport: A2AHttpTransport;
    const PORT = 41234;
    const BASE_URL = `http://127.0.0.1:${PORT}`;

    const mockHandler: A2ATaskHandler = {
      handleIncomingA2ARequest: vi.fn().mockImplementation(
        async (req: A2ATaskExecutionRequest): Promise<A2ATaskExecutionResult> => {
          return {
            success: true,
            output: { answer: 42, processedText: (req.parameters as any)?.text },
            escrowStatus: 'released',
            metrics: { latencyMs: 25, costUsd: req.costUsd },
          };
        },
      ),
      getTaskStatus: vi.fn().mockResolvedValue({ status: 'completed', output: { answer: 42 } }),
      cancelTask: vi.fn().mockResolvedValue({ cancelled: true }),
    };

    beforeAll(async () => {
      bobTransport = new A2AHttpTransport({
        identity: bobIdentity,
        handler: mockHandler,
        agentCardOptions: {
          name: 'Bob Real Transport Agent',
          endpoints: {
            http: `${BASE_URL}/a2a`,
            wellKnown: `${BASE_URL}/.well-known/agent-card.json`,
          },
        },
      });

      await bobTransport.start(PORT, '127.0.0.1');
    });

    afterAll(async () => {
      await bobTransport.stop();
    });

    it('serves signed Agent Card at /.well-known/agent-card.json', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/agent-card.json`);
      expect(res.status).toBe(200);

      const card = (await res.json()) as any;
      expect(card.signerAgentId).toBe('agent-bob');
      expect(card.signature).toBeDefined();

      const verification = AgentIdentity.verifyAgentCard(card);
      expect(verification.valid).toBe(true);
      expect((verification.data as any).id).toBe('agent-bob');
    });

    it('dispatches valid signed task via REST POST /a2a/tasks and returns execution result', async () => {
      const aliceTransport = new A2AHttpTransport({
        identity: aliceIdentity,
        handler: { handleIncomingA2ARequest: vi.fn() },
      });

      const request: A2ATaskExecutionRequest = {
        taskId: 'task-http-001',
        toolId: 'fast-json-parser',
        parameters: { text: 'ping pong' },
        costUsd: 0.1,
        clientAgentId: 'agent-alice',
        providerAgentId: 'agent-bob',
        timeoutMs: 15_000,
      };

      const result = await aliceTransport.sendA2ARequest(BASE_URL, request);

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ answer: 42, processedText: 'ping pong' });
      expect(mockHandler.handleIncomingA2ARequest).toHaveBeenCalled();
    });

    it('rejects unsigned task request on HTTP REST endpoint with 401 Unauthorized', async () => {
      const rawUnsignedRequest = {
        taskId: 'unsigned-task-1',
        toolId: 'test-tool',
        parameters: {},
        costUsd: 0.1,
        clientAgentId: 'agent-alice',
        providerAgentId: 'agent-bob',
      };

      const res = await fetch(`${BASE_URL}/a2a/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rawUnsignedRequest),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error).toContain('missing Ed25519 cryptographic signature');
    });

    it('rejects task with tampered signature on HTTP REST endpoint', async () => {
      const legitRequest = aliceIdentity.signA2ARequest({
        taskId: 'tampered-task-http',
        toolId: 'test-tool',
        parameters: { amount: 10 },
        costUsd: 0.1,
        clientAgentId: 'agent-alice',
        providerAgentId: 'agent-bob',
      });

      // Tamper parameter
      legitRequest.parameters = { amount: 99999 };

      const res = await fetch(`${BASE_URL}/a2a/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legitRequest),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error).toContain('Cryptographic verification failed');
    });

    it('executes task via JSON-RPC 2.0 /a2a/rpc createTask', async () => {
      const aliceTransport = new A2AHttpTransport({
        identity: aliceIdentity,
        handler: { handleIncomingA2ARequest: vi.fn() },
      });

      const request: A2ATaskExecutionRequest = {
        taskId: 'task-rpc-001',
        toolId: 'summarize',
        parameters: { text: 'json-rpc call' },
        costUsd: 0.05,
        clientAgentId: 'agent-alice',
        providerAgentId: 'agent-bob',
      };

      const result = await aliceTransport.sendA2ARequest(BASE_URL, request, {
        useJsonRpc: true,
      });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ answer: 42, processedText: 'json-rpc call' });
    });

    it('retrieves Agent Card via JSON-RPC 2.0 method getAgentCard', async () => {
      const res = await fetch(`${BASE_URL}/a2a/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAgentCard',
        }),
      });

      expect(res.status).toBe(200);
      const rpcRes = (await res.json()) as any;
      expect(rpcRes.result.signerAgentId).toBe('agent-bob');
    });
  });

  describe('WebSocket Transport (Streaming & Notifications)', () => {
    let bobHttp: A2AHttpTransport;
    let bobWs: A2AWsTransport;
    const WS_PORT = 41235;

    const mockWsHandler: A2ATaskHandler = {
      handleIncomingA2ARequest: vi.fn().mockImplementation(
        async (req: A2ATaskExecutionRequest): Promise<A2ATaskExecutionResult> => {
          return {
            success: true,
            output: { streamed: true, task: req.taskId },
            escrowStatus: 'released',
            metrics: { latencyMs: 12, costUsd: 0.05 },
          };
        },
      ),
    };

    beforeAll(async () => {
      bobHttp = new A2AHttpTransport({
        identity: bobIdentity,
        handler: mockWsHandler,
      });

      const bobServer = await bobHttp.start(WS_PORT, '127.0.0.1');
      bobWs = new A2AWsTransport({
        identity: bobIdentity,
        handler: mockWsHandler,
        server: bobServer,
      });
    });

    afterAll(async () => {
      await bobWs.close();
      await bobHttp.stop();
    });

    it('establishes WebSocket connection and delegates task with live notifications', async () => {
      const client = new A2AWsClient({
        identity: aliceIdentity,
        peerWsUrl: `ws://127.0.0.1:${WS_PORT}/a2a/ws`,
        peerAgentId: 'agent-bob',
      });

      const progressUpdates: any[] = [];
      const result = await client.executeTask(
        {
          taskId: 'task-ws-streaming-001',
          toolId: 'stream-tool',
          parameters: { input: 'ws-test' },
          costUsd: 0.05,
          clientAgentId: 'agent-alice',
          providerAgentId: 'agent-bob',
          timeoutMs: 10_000,
        },
        (update) => {
          progressUpdates.push(update);
        },
      );

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ streamed: true, task: 'task-ws-streaming-001' });
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates.some((p) => p.status === 'executing')).toBe(true);

      client.close();
    });

    it('rejects tampered or unsigned messages over WebSocket', async () => {
      const rawWs = new WsNodeClient(`ws://127.0.0.1:${WS_PORT}/a2a/ws`);

      await new Promise<void>((resolve) => {
        rawWs.on('open', resolve);
      });

      const responsePromise = new Promise<any>((resolve) => {
        rawWs.on('message', (data) => {
          resolve(JSON.parse(data.toString('utf8')));
        });
      });

      // Send unsigned message
      rawWs.send(
        JSON.stringify({
          action: 'create_task',
          senderAgentId: 'agent-alice',
          payload: { taskId: 'tampered-ws-task' },
          // No signature!
        }),
      );

      const reply = await responsePromise;
      expect(reply.type).toBe('error');
      expect(reply.error).toContain('Cryptographic verification failed');

      rawWs.close();
    });
  });
});
