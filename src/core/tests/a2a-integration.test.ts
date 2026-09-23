import { describe, expect, it, vi } from 'vitest';
import { A2AAgentOrchestrator } from '../a2a-orchestrator.js';
import type { MetaToolManager } from '../meta-tools/manager.js';
import type { EscrowSystemInterface } from '../types/a2a.types.js';

const request = {
  taskId: 'task-123',
  toolId: 'tool-abc',
  parameters: { query: 'hello' },
  costUsd: 12.5,
  clientAgentId: 'client-agent',
  providerAgentId: 'provider-agent',
};

function createEscrowMock(): EscrowSystemInterface {
  return {
    lockFunds: vi.fn().mockResolvedValue({ success: true, escrowId: 'escrow-456' }),
    releaseFunds: vi.fn().mockResolvedValue({ success: true }),
    refundFunds: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe('A2AAgentOrchestrator escrow integration', () => {
  it('releases locked funds after accepted execution', async () => {
    const escrow = createEscrowMock();
    const manager = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: { answer: 'ok' },
        evaluationScore: 1,
        ratchetDecision: 'accepted',
        metrics: {},
        toolVersionUsed: 1,
      }),
    } as unknown as MetaToolManager;
    const orchestrator = new A2AAgentOrchestrator(manager, escrow);

    const result = await orchestrator.executeTask(request);

    expect(result).toMatchObject({ success: true, escrowStatus: 'released' });
    expect(escrow.lockFunds).toHaveBeenCalledWith({
      taskId: request.taskId,
      amount: request.costUsd,
      from: request.clientAgentId,
      to: request.providerAgentId,
    });
    expect(escrow.releaseFunds).toHaveBeenCalledWith(request.taskId, 'escrow-456');
    expect(escrow.refundFunds).not.toHaveBeenCalled();
  });

  it('refunds locked funds when the ratchet rejects execution', async () => {
    const escrow = createEscrowMock();
    const manager = {
      execute: vi.fn().mockResolvedValue({
        success: false,
        output: null,
        error: 'Evaluation threshold not met',
        evaluationScore: 0.5,
        ratchetDecision: 'rejected',
        metrics: {},
        toolVersionUsed: 1,
      }),
    } as unknown as MetaToolManager;
    const orchestrator = new A2AAgentOrchestrator(manager, escrow);

    const result = await orchestrator.executeTask(request);

    expect(result).toMatchObject({ success: false, escrowStatus: 'refunded' });
    expect(escrow.refundFunds).toHaveBeenCalledWith(
      request.taskId,
      'escrow-456',
      'ratchet_rejected',
    );
    expect(escrow.releaseFunds).not.toHaveBeenCalled();
  });

  it('refunds locked funds after an unexpected execution error', async () => {
    const escrow = createEscrowMock();
    const manager = {
      execute: vi.fn().mockRejectedValue(new Error('Sandbox crash')),
    } as unknown as MetaToolManager;
    const orchestrator = new A2AAgentOrchestrator(manager, escrow);

    const result = await orchestrator.executeTask(request);

    expect(result).toMatchObject({
      success: false,
      escrowStatus: 'refunded',
      error: 'Unexpected orchestration failure: Sandbox crash',
    });
    expect(escrow.refundFunds).toHaveBeenCalledWith(
      request.taskId,
      'escrow-456',
      'unexpected_orchestration_failure:Sandbox crash',
    );
  });
});
