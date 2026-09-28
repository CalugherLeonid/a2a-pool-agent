/**
 * Real M2M WebSocket Transport Adapter for A2A Streaming & Notifications.
 *
 * Provides:
 *  - WebSocket Server for real-time task status streaming and notifications.
 *  - Zero-Trust cryptographic envelope verification (Ed25519) on all inbound messages.
 *  - Automatic message signing on outbound events.
 *  - Task subscription model allowing clients to follow task execution lifecycle.
 *  - WebSocket Client helper for establishing peer connections.
 */

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Server } from 'node:http';
import {
  AgentIdentity,
  type A2AMessage,
} from '../../identity/agent-identity.js';
import type {
  A2ATaskExecutionRequest,
} from '../../core/types/a2a.types.js';
import type { A2ATaskHandler } from './http-transport.js';
import { createLogger } from '../../observability/logger.js';
import type { RateLimiter } from '../../core/resilience/rate-limiter.js';

export interface A2AWsTransportOptions {
  identity: AgentIdentity;
  handler: A2ATaskHandler;
  rateLimiter?: RateLimiter;
  server?: Server;
  port?: number;
}

export interface TaskStatusNotification {
  taskId: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  progress?: number;
  output?: unknown;
  error?: string;
  metrics?: { latencyMs?: number; costUsd?: number };
}

export class A2AWsTransport {
  private readonly log = createLogger('a2a-ws-transport');
  private readonly identity: AgentIdentity;
  private readonly handler: A2ATaskHandler;
  private readonly rateLimiter?: RateLimiter;
  private wss?: WebSocketServer;
  private readonly subscriptions = new Map<string, Set<WebSocket>>(); // taskId -> sockets
  private readonly authenticatedPeers = new Map<WebSocket, string>(); // socket -> agentId

  constructor(options: A2AWsTransportOptions) {
    this.identity = options.identity;
    this.handler = options.handler;
    this.rateLimiter = options.rateLimiter;

    if (options.server) {
      this.initWss({ server: options.server });
    } else if (options.port) {
      this.initWss({ port: options.port });
    }
  }

  public initWss(serverOptions: { server?: Server; port?: number }): WebSocketServer {
    this.wss = new WebSocketServer({ ...serverOptions, path: '/a2a/ws' });
    this.log.info('A2A WebSocket server initialized at /a2a/ws');

    this.wss.on('connection', (ws: WebSocket) => {
      this.log.info('incoming peer WebSocket connection established');

      ws.on('message', async (data: RawData) => {
        try {
          const text = data.toString('utf8');
          const message = JSON.parse(text) as A2AMessage<unknown>;

          // Zero-Trust verification of every incoming message
          const verification = AgentIdentity.verifyMessage(message, {
            expectedRecipientId: this.identity.agentId,
          });

          if (!verification.valid) {
            this.log.warn({ error: verification.error }, 'rejected invalid WebSocket message');
            ws.send(
              JSON.stringify({
                type: 'error',
                error: `Cryptographic verification failed: ${verification.error}`,
              }),
            );
            return;
          }

          const senderId = verification.signerAgentId ?? message.senderAgentId;
          this.authenticatedPeers.set(ws, senderId);

          await this.handleVerifiedMessage(ws, message);
        } catch (err) {
          this.log.error({ err }, 'error processing WebSocket message');
          ws.send(JSON.stringify({ type: 'error', error: 'Malformed message format' }));
        }
      });

      ws.on('close', () => {
        this.authenticatedPeers.delete(ws);
        for (const subscribers of this.subscriptions.values()) {
          subscribers.delete(ws);
        }
      });
    });

    return this.wss;
  }

  private async handleVerifiedMessage(
    ws: WebSocket,
    message: A2AMessage<unknown>,
  ): Promise<void> {
    switch (message.action) {
      case 'create_task': {
        const taskReq = message.payload as A2ATaskExecutionRequest;

        // Inbound rate limit check
        if (this.rateLimiter && !this.rateLimiter.tryConsume(1)) {
          this.log.warn({ taskId: taskReq.taskId }, 'A2A WS inbound rate limit exceeded (429)');
          this.emitStatusUpdate(taskReq.taskId, {
            taskId: taskReq.taskId,
            status: 'failed',
            error: 'Rate limit exceeded (429 Too Many Requests)',
          });
          ws.send(
            JSON.stringify({
              type: 'error',
              error: 'Rate limit exceeded (429 Too Many Requests)',
            }),
          );
          break;
        }

        // Subscribe the calling socket to status updates for this task
        this.subscribeSocketToTask(taskReq.taskId, ws);

        // Stream initial 'pending' status
        this.emitStatusUpdate(taskReq.taskId, {
          taskId: taskReq.taskId,
          status: 'executing',
          progress: 0.1,
        });

        try {
          const result = await this.handler.handleIncomingA2ARequest(taskReq);
          // Stream completed notification
          this.emitStatusUpdate(taskReq.taskId, {
            taskId: taskReq.taskId,
            status: result.success ? 'completed' : 'failed',
            output: result.output,
            error: result.error,
            metrics: result.metrics,
          });

          // Send signed artifact delivery
          const signedArtifact = this.identity.signMessage(
            'artifact_delivery',
            result,
            { recipientAgentId: message.senderAgentId },
          );
          ws.send(JSON.stringify(signedArtifact));
        } catch (err: any) {
          this.emitStatusUpdate(taskReq.taskId, {
            taskId: taskReq.taskId,
            status: 'failed',
            error: err?.message ?? String(err),
          });
        }
        break;
      }

      case 'task_status': {
        const payload = message.payload as { taskId: string };
        if (payload?.taskId) {
          this.subscribeSocketToTask(payload.taskId, ws);
          if (this.handler.getTaskStatus) {
            const status = await this.handler.getTaskStatus(payload.taskId);
            if (status) {
              const reply = this.identity.signMessage('task_status', status, {
                recipientAgentId: message.senderAgentId,
              });
              ws.send(JSON.stringify(reply));
            }
          }
        }
        break;
      }

      case 'cancel_task': {
        const payload = message.payload as { taskId: string; reason?: string };
        if (payload?.taskId && this.handler.cancelTask) {
          const outcome = await this.handler.cancelTask(payload.taskId, payload.reason);
          const reply = this.identity.signMessage('task_status', outcome, {
            recipientAgentId: message.senderAgentId,
          });
          ws.send(JSON.stringify(reply));
        }
        break;
      }

      default:
        this.log.debug({ action: message.action }, 'unhandled A2A action');
        break;
    }
  }

  private subscribeSocketToTask(taskId: string, ws: WebSocket): void {
    let subs = this.subscriptions.get(taskId);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(taskId, subs);
    }
    subs.add(ws);
  }

  /**
   * Broadcasts a signed status notification to all subscribed peers for a task.
   */
  public emitStatusUpdate(taskId: string, update: TaskStatusNotification): void {
    const sockets = this.subscriptions.get(taskId);
    if (!sockets || sockets.size === 0) return;

    const signedMsg = this.identity.signMessage('task_status', update);
    const json = JSON.stringify(signedMsg);

    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }

    if (update.status === 'completed' || update.status === 'failed') {
      this.subscriptions.delete(taskId);
    }
  }

  public async close(): Promise<void> {
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss?.close(() => resolve());
      });
      this.wss = undefined;
      this.log.info('A2A WebSocket transport closed');
    }
  }
}
