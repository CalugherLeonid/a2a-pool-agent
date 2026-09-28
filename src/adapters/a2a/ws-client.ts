/**
 * Real M2M WebSocket Client for A2A Task Delegation and Real-Time Streaming.
 */

import { WebSocket } from 'ws';
import { AgentIdentity, type A2AMessage } from '../../identity/agent-identity.js';
import type {
  A2ATaskExecutionRequest,
  A2ATaskExecutionResult,
} from '../../core/types/a2a.types.js';
import type { TaskStatusNotification } from './ws-transport.js';
import { createLogger } from '../../observability/logger.js';

export interface A2AWsClientOptions {
  identity: AgentIdentity;
  peerWsUrl: string;
  peerAgentId: string;
}

export class A2AWsClient {
  private readonly log = createLogger('a2a-ws-client');
  private readonly identity: AgentIdentity;
  private readonly peerWsUrl: string;
  private readonly peerAgentId: string;
  private ws?: WebSocket;
  private readonly pendingTasks = new Map<
    string,
    {
      resolve: (result: A2ATaskExecutionResult) => void;
      reject: (err: Error) => void;
      onProgress?: (notif: TaskStatusNotification) => void;
    }
  >();

  constructor(options: A2AWsClientOptions) {
    this.identity = options.identity;
    this.peerWsUrl = options.peerWsUrl;
    this.peerAgentId = options.peerAgentId;
  }

  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.peerWsUrl);
      this.ws = ws;

      ws.on('open', () => {
        this.log.info({ peer: this.peerAgentId, url: this.peerWsUrl }, 'connected to peer WebSocket');
        resolve();
      });

      ws.on('error', (err) => {
        this.log.error({ err }, 'peer WebSocket connection error');
        reject(err);
      });

      ws.on('message', (data) => {
        try {
          const text = data.toString('utf8');
          const parsed = JSON.parse(text);

          if (parsed.type === 'error') {
            this.log.warn({ error: parsed.error }, 'peer returned error');
            return;
          }

          const message = parsed as A2AMessage<unknown>;
          const verification = AgentIdentity.verifyMessage(message, {
            expectedRecipientId: this.identity.agentId,
          });

          if (!verification.valid) {
            this.log.warn({ error: verification.error }, 'received unverified message from peer');
            return;
          }

          if (message.action === 'task_status') {
            const notif = message.payload as TaskStatusNotification;
            const pending = this.pendingTasks.get(notif.taskId);
            if (pending?.onProgress) {
              pending.onProgress(notif);
            }
          } else if (message.action === 'artifact_delivery') {
            const result = message.payload as A2ATaskExecutionResult;
            if (!result.telemetry) {
              result.telemetry = {
                provider: 'peer',
                model: 'ws-tool',
                latencyMs: result.metrics?.latencyMs ?? 0,
                tokensIn: 0,
                tokensOut: 0,
                costUsd: result.metrics?.costUsd ?? 0,
                fallbackUsed: false,
                fallbackChain: ['ws-transport'],
                systemPath: 'system2',
                timestamp: new Date().toISOString(),
                peerId: this.peerAgentId,
                transport: 'ws',
              };
            } else {
              result.telemetry.transport = 'ws';
              result.telemetry.peerId = this.peerAgentId;
            }

            // Lookup corresponding pending task
            for (const [taskId, pending] of this.pendingTasks.entries()) {
              pending.resolve(result);
              this.pendingTasks.delete(taskId);
              break;
            }
          }
        } catch (err) {
          this.log.error({ err }, 'error handling peer message');
        }
      });

      ws.on('close', () => {
        this.log.info({ peer: this.peerAgentId }, 'peer WebSocket closed');
        for (const pending of this.pendingTasks.values()) {
          pending.reject(new Error('WebSocket connection closed'));
        }
        this.pendingTasks.clear();
      });
    });
  }

  public async executeTask(
    request: A2ATaskExecutionRequest,
    onProgress?: (notif: TaskStatusNotification) => void,
  ): Promise<A2ATaskExecutionResult> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    const signedMessage = this.identity.signMessage('create_task', request, {
      recipientAgentId: this.peerAgentId,
      ttlMs: request.timeoutMs ?? 30_000,
    });

    return new Promise((resolve, reject) => {
      this.pendingTasks.set(request.taskId, { resolve, reject, onProgress });
      this.ws?.send(JSON.stringify(signedMessage));

      const timer = setTimeout(() => {
        if (this.pendingTasks.has(request.taskId)) {
          this.pendingTasks.delete(request.taskId);
          reject(new Error(`A2A task ${request.taskId} timed out after ${request.timeoutMs ?? 30_000}ms`));
        }
      }, (request.timeoutMs ?? 30_000) + 5_000);

      const originalResolve = resolve;
      this.pendingTasks.get(request.taskId)!.resolve = (res) => {
        clearTimeout(timer);
        originalResolve(res);
      };
    });
  }

  public close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }
}
