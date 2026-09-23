import { beforeEach, describe, expect, it, vi } from 'vitest';
import { A2AAgentOrchestrator } from '../a2a-orchestrator.js';
import { EscrowSystem } from '../escrow.js';
import type { MetaToolManager } from '../meta-tools/manager.js';
import type { A2ATaskExecutionRequest } from '../types/a2a.types.js';

const request: A2ATaskExecutionRequest = {
  taskId: 'e2e-task-123',
  toolId: 'create-tool',
  parameters: { name: 'test-tool' },
  costUsd: 50,
  clientAgentId: 'agent-A',
  providerAgentId: 'agent-B',
  timeoutMs: 5_000,
};

describe('E2E: A2A + Meta-Tools + Escrow', () => {
  let escrow: EscrowSystem;
  let execute: ReturnType<typeof vi.fn<MetaToolManager['execute']>>;
  let orchestrator: A2AAgentOrchestrator;

  beforeEach(() => {
    escrow = new EscrowSystem(3);
    execute = vi.fn<MetaToolManager['execute']>();
    const metaToolManager: Pick<MetaToolManager, 'execute'> = { execute };
    orchestrator = new A2AAgentOrchestrator(metaToolManager, escrow);
  });

  it('Full Happy Path - A2A Task with Escrow and Ratchet Acceptance', async () => {
    // A successful, ratchet-approved execution must release the real escrow record.
    execute.mockResolvedValue({
      success: true,
      output: { result: 'tool created' },
      evaluationScore: 1,
      ratchetDecision: 'accepted',
      metrics: {},
      toolVersionUsed: 1,
    });

    const result = await orchestrator.executeA2ATask(request);

    expect(result.success).toBe(true);
    expect(result.escrowStatus).toBe('released');
    expect(result.ratchetDecision).toBe('accepted');
    expect(result.metrics.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.metrics.costUsd).toBe(request.costUsd);
    expect(escrow.getStuckTransactions()).toEqual([]);
  });

  it('Ratchet Rejection Triggers Automatic Refund', async () => {
    // A rejected candidate must refund the client rather than leave locked funds behind.
    execute.mockResolvedValue({
      success: false,
      output: null,
      error: 'Malicious pattern detected',
      evaluationScore: 0,
      ratchetDecision: 'rejected',
      metrics: {},
      toolVersionUsed: 1,
    });

    const result = await orchestrator.executeA2ATask(request);

    expect(result.success).toBe(false);
    expect(result.escrowStatus).toBe('refunded');
    expect(result.error).toContain('rejected');
    expect(escrow.getStuckTransactions()).toEqual([]);
  });

  it('Escrow Lock Failure Prevents Execution', async () => {
    // A processed task cannot be locked again, so execution must not even start.
    const initialLock = await escrow.lockFunds({
      taskId: 'task-conflict',
      amount: request.costUsd,
      from: request.clientAgentId,
      to: request.providerAgentId,
    });
    expect(initialLock.success).toBe(true);
    const initialRelease = await escrow.releaseFunds('task-conflict', initialLock.escrowId!);
    expect(initialRelease.success).toBe(true);

    const result = await orchestrator.executeA2ATask({
      ...request,
      taskId: 'task-conflict',
    });

    expect(result.success).toBe(false);
    expect(result.escrowStatus).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('Unexpected Execution Error Triggers Refund and Reconciliation', async () => {
    // Crashes after a successful lock are caught and refunded through the real escrow system.
    execute.mockRejectedValue(new Error('Sandbox OOM'));

    const result = await orchestrator.executeA2ATask(request);

    expect(result.success).toBe(false);
    expect(result.escrowStatus).toBe('refunded');
    expect(result.error).toContain('Unexpected orchestration failure');
    expect(escrow.getStuckTransactions()).toEqual([]);
  });

  it('Idempotent Task Replay Returns a Lock Failure After Release', async () => {
    // The first completed task is RELEASED; replaying its task ID cannot create a new escrow.
    execute.mockResolvedValue({
      success: true,
      output: { result: 'tool created' },
      evaluationScore: 1,
      ratchetDecision: 'accepted',
      metrics: {},
      toolVersionUsed: 1,
    });

    const initialResult = await orchestrator.executeA2ATask(request);
    const replayResult = await orchestrator.executeA2ATask(request);

    expect(initialResult).toMatchObject({ success: true, escrowStatus: 'released' });
    expect(replayResult).toMatchObject({ success: false, escrowStatus: 'failed' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
