/**
 * Real M2M HTTP Transport Adapter for Agent-to-Agent (A2A) Communication.
 *
 * Provides:
 *  - REST endpoints for task creation, retrieval, and cancellation.
 *  - JSON-RPC 2.0 endpoint (/a2a/rpc) for standardized A2A method calls.
 *  - Well-Known Agent Card publishing at /.well-known/agent-card.json with JWS Ed25519 signature.
 *  - Zero-Trust cryptographic verification on all incoming requests.
 *  - Client for sending signed requests to peer agents with response verification.
 */

import express, { type Request, type Response, type Router } from 'express';
import type { Server } from 'node:http';
import type { AgentIdentity, SignedAgentCard } from '../../identity/agent-identity.js';
import { AgentIdentity as AgentIdentityClass } from '../../identity/agent-identity.js';
import type {
  A2ATaskExecutionRequest,
  A2ATaskExecutionResult,
} from '../../core/types/a2a.types.js';
import { generateSignedAgentCard, type CreateAgentCardOptions } from './agent-card.js';
import { createLogger } from '../../observability/logger.js';
import type { RateLimiter } from '../../core/resilience/rate-limiter.js';
import type { ExecutionTelemetry } from '../../telemetry/types.js';

export interface A2ATaskHandler {
  handleIncomingA2ARequest(
    request: A2ATaskExecutionRequest,
  ): Promise<A2ATaskExecutionResult>;
  getTaskStatus?(taskId: string): Promise<{ status: string; output?: unknown } | undefined>;
  cancelTask?(taskId: string, reason?: string): Promise<{ cancelled: boolean; error?: string }>;
}

export interface A2AHttpTransportOptions {
  identity: AgentIdentity;
  handler: A2ATaskHandler;
  rateLimiter?: RateLimiter;
  agentCardOptions?: Omit<CreateAgentCardOptions, 'agentId' | 'publicKeyPem' | 'publicKeyHex'>;
  port?: number;
  host?: string;
}

export class A2AHttpTransport {
  private readonly log = createLogger('a2a-http-transport');
  private readonly identity: AgentIdentity;
  private readonly handler: A2ATaskHandler;
  private readonly rateLimiter?: RateLimiter;
  private readonly agentCardOptions: Omit<CreateAgentCardOptions, 'agentId' | 'publicKeyPem' | 'publicKeyHex'>;
  private signedCard: SignedAgentCard;
  private server?: Server;

  constructor(options: A2AHttpTransportOptions) {
    this.identity = options.identity;
    this.handler = options.handler;
    this.rateLimiter = options.rateLimiter;
    this.agentCardOptions = options.agentCardOptions ?? {
      name: options.identity.agentId,
      version: '1.0.0',
    };

    // Pre-generate and sign the Agent Card
    this.signedCard = generateSignedAgentCard(this.identity, this.agentCardOptions);
  }

  /** Refreshes and re-signs the published Agent Card */
  public refreshAgentCard(): SignedAgentCard {
    this.signedCard = generateSignedAgentCard(this.identity, this.agentCardOptions);
    return this.signedCard;
  }

  /** Returns current signed Agent Card */
  public getSignedAgentCard(): SignedAgentCard {
    return this.signedCard;
  }

  /** Sets and publishes an externally signed Agent Card (e.g. from DynamicAgentCardManager) */
  public setSignedAgentCard(signedCard: SignedAgentCard): void {
    this.signedCard = signedCard;
  }

  /**
   * Express router mounting all A2A M2M endpoints.
   */
  public createRouter(): Router {
    const router = express.Router();
    router.use(express.json());

    // 1. Well-Known Agent Card Endpoint
    router.get('/.well-known/agent-card.json', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.status(200).json(this.signedCard);
    });

    // 2. REST: Create Task
    router.post('/a2a/tasks', async (req: Request, res: Response) => {
      const request = req.body as A2ATaskExecutionRequest;
      if (!request || !request.taskId || !request.toolId) {
        res.status(400).json({ error: 'Invalid task request payload' });
        return;
      }

      // Zero-Trust verification: enforce Ed25519 signature
      if (!request.signature) {
        this.log.warn({ taskId: request.taskId }, 'rejected unsigned A2A task request');
        res.status(401).json({
          error: 'Unauthorized: missing Ed25519 cryptographic signature',
        });
        return;
      }

      const verification = AgentIdentityClass.verifyA2ARequest(request, {
        expectedProviderId: this.identity.agentId,
      });
      if (!verification.valid) {
        this.log.warn(
          { taskId: request.taskId, error: verification.error },
          'rejected A2A task request: signature verification failed',
        );
        res.status(401).json({
          error: `Cryptographic verification failed: ${verification.error}`,
        });
        return;
      }

      // Inbound rate limit check
      if (this.rateLimiter && !this.rateLimiter.tryConsume(1)) {
        this.log.warn(
          { taskId: request.taskId, client: request.clientAgentId },
          'HTTP A2A inbound rate limit exceeded (429)',
        );
        res.status(429).json({ error: 'Too Many Requests: rate limit exceeded' });
        return;
      }

      try {
        const result = await this.handler.handleIncomingA2ARequest(request);
        if (result.error && result.error.includes('429')) {
          res.status(429).json(result);
          return;
        }
        res.status(200).json(result);
      } catch (err) {
        this.log.error({ err, taskId: request.taskId }, 'error processing A2A task');
        res.status(500).json({ error: `Internal processing error: ${String(err)}` });
      }
    });

    // 3. REST: Get Task Status
    router.get('/a2a/tasks/:taskId', async (req: Request, res: Response) => {
      const taskId = req.params['taskId'] as string;
      if (this.handler.getTaskStatus) {
        const status = await this.handler.getTaskStatus(taskId);
        if (status) {
          res.status(200).json({ taskId, ...status });
          return;
        }
      }
      res.status(404).json({ error: `Task ${taskId} not found` });
    });

    // 4. REST: Cancel Task
    router.post('/a2a/tasks/:taskId/cancel', async (req: Request, res: Response) => {
      const taskId = req.params['taskId'] as string;
      const reason = (req.body?.reason as string) ?? 'cancelled_by_client';
      if (this.handler.cancelTask) {
        const outcome = await this.handler.cancelTask(taskId, reason);
        res.status(200).json(outcome);
        return;
      }
      res.status(501).json({ error: 'Cancellation not supported' });
    });

    // 5. JSON-RPC 2.0 Endpoint
    router.post('/a2a/rpc', async (req: Request, res: Response) => {
      const { jsonrpc, id, method, params } = req.body ?? {};

      if (jsonrpc !== '2.0' || !id || !method) {
        res.status(400).json({
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32600, message: 'Invalid JSON-RPC 2.0 Request' },
        });
        return;
      }

      try {
        switch (method) {
          case 'getAgentCard': {
            res.status(200).json({ jsonrpc: '2.0', id, result: this.signedCard });
            return;
          }

          case 'createTask': {
            const request = params as A2ATaskExecutionRequest;
            if (!request?.signature) {
              res.status(200).json({
                jsonrpc: '2.0',
                id,
                error: {
                  code: -32001,
                  message: 'Cryptographic verification failed: missing signature',
                },
              });
              return;
            }

            const verification = AgentIdentityClass.verifyA2ARequest(request, {
              expectedProviderId: this.identity.agentId,
            });
            if (!verification.valid) {
              res.status(200).json({
                jsonrpc: '2.0',
                id,
                error: {
                  code: -32001,
                  message: `Cryptographic verification failed: ${verification.error}`,
                },
              });
              return;
            }

            if (this.rateLimiter && !this.rateLimiter.tryConsume(1)) {
              this.log.warn(
                { taskId: request.taskId, client: request.clientAgentId },
                'A2A JSON-RPC createTask rate limit exceeded (429)',
              );
              res.status(429).json({
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: 'Too Many Requests: rate limit exceeded' },
              });
              return;
            }

            const taskResult = await this.handler.handleIncomingA2ARequest(request);
            if (taskResult.error && taskResult.error.includes('429')) {
              res.status(429).json({
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: taskResult.error },
              });
              return;
            }
            res.status(200).json({ jsonrpc: '2.0', id, result: taskResult });
            return;
          }

          case 'getTask': {
            const taskId = params?.taskId;
            if (taskId && this.handler.getTaskStatus) {
              const status = await this.handler.getTaskStatus(taskId);
              res.status(200).json({ jsonrpc: '2.0', id, result: status });
              return;
            }
            res.status(200).json({
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'Task status not found' },
            });
            return;
          }

          case 'cancelTask': {
            const taskId = params?.taskId;
            if (taskId && this.handler.cancelTask) {
              const outcome = await this.handler.cancelTask(taskId, params?.reason);
              res.status(200).json({ jsonrpc: '2.0', id, result: outcome });
              return;
            }
            res.status(200).json({
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: 'Cancel not supported' },
            });
            return;
          }

          default:
            res.status(200).json({
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Method '${method}' not found` },
            });
            return;
        }
      } catch (err) {
        res.status(200).json({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: `Internal error: ${String(err)}` },
        });
      }
    });

    return router;
  }

  /**
   * Starts a standalone HTTP listener.
   */
  public async start(port: number, host = '0.0.0.0'): Promise<Server> {
    const app = express();
    app.use(this.createRouter());

    return new Promise((resolve, reject) => {
      try {
        const srv = app.listen(port, host, () => {
          this.server = srv;
          this.log.info({ port, host }, 'A2A HTTP transport started');
          resolve(srv);
        });
        srv.on('error', reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stops the HTTP listener.
   */
  public async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((err) => (err ? reject(err) : resolve()));
      });
      this.server = undefined;
      this.log.info('A2A HTTP transport stopped');
    }
  }

  /**
   * Client helper: sends a signed A2ATaskExecutionRequest to a peer agent over HTTP.
   * Auto-signs outbound request if unsigned, and verifies the returned result.
   */
  public async sendA2ARequest(
    peerBaseUrl: string,
    request: A2ATaskExecutionRequest,
    options?: { useJsonRpc?: boolean; timeoutMs?: number },
  ): Promise<A2ATaskExecutionResult> {
    const signedRequest = request.signature
      ? request
      : this.identity.signA2ARequest(request, request.timeoutMs ?? 30_000);

    const cleanBase = peerBaseUrl.replace(/\/+$/, '').replace(/\/a2a(\/rpc|\/tasks)?$/, '');
    const useRpc = options?.useJsonRpc ?? false;
    const url = useRpc ? `${cleanBase}/a2a/rpc` : `${cleanBase}/a2a/tasks`;

    this.log.info({ url, taskId: request.taskId, peer: request.providerAgentId }, 'dispatching A2A task via HTTP');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? request.timeoutMs ?? 35_000);
    const startTime = Date.now();

    try {
      let res: globalThis.Response;
      if (useRpc) {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: request.taskId,
            method: 'createTask',
            params: signedRequest,
          }),
          signal: controller.signal,
        });
      } else {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signedRequest),
          signal: controller.signal,
        });
      }

      if (!res.ok) {
        const errorText = await res.text();
        return {
          success: false,
          error: `HTTP ${res.status}: ${errorText}`,
          escrowStatus: 'failed',
          metrics: { latencyMs: 0, costUsd: 0 },
        };
      }

      const json = (await res.json()) as any;
      const result: A2ATaskExecutionResult = useRpc ? json.result : json;

      if (!result) {
        return {
          success: false,
          error: json.error?.message ?? 'Empty response from peer',
          escrowStatus: 'failed',
          metrics: { latencyMs: 0, costUsd: 0 },
        };
      }

      // Verify the returned artifact's Ed25519 signature if present
      if (result.signature) {
        const verification = AgentIdentityClass.verifyA2AResult(
          result,
          request.taskId,
          result.signerPubkey,
        );
        if (!verification.valid) {
          this.log.warn({ taskId: request.taskId, error: verification.error }, 'A2A result signature verification failed');
          return {
            ...result,
            success: false,
            error: `Result signature verification failed: ${verification.error}`,
          };
        }
      }

      const latencyMs = Date.now() - startTime;
      const telemetry: ExecutionTelemetry = result.telemetry ?? {
        provider: 'peer',
        model: request.toolId,
        latencyMs: result.metrics?.latencyMs || latencyMs,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: result.metrics?.costUsd || request.costUsd,
        fallbackUsed: false,
        fallbackChain: ['http-transport'],
        systemPath: 'system2',
        timestamp: new Date().toISOString(),
        peerId: request.providerAgentId,
        transport: 'http',
      };
      telemetry.transport = 'http';
      telemetry.peerId = request.providerAgentId;
      result.telemetry = telemetry;

      return result;
    } catch (err: any) {
      this.log.error({ err, taskId: request.taskId }, 'A2A HTTP client dispatch error');
      return {
        success: false,
        error: `Network error dispatching A2A task: ${err?.message ?? String(err)}`,
        escrowStatus: 'failed',
        metrics: { latencyMs: 0, costUsd: 0 },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
