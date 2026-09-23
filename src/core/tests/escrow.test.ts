import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EscrowSystem } from '../escrow.js';

describe('EscrowSystem (Module 8.5)', () => {
  let escrow: EscrowSystem;
  const validParams = {
    taskId: 'task-123',
    amount: 100,
    from: 'agent-A',
    to: 'agent-B',
  };

  beforeEach(() => {
    escrow = new EscrowSystem(3);
  });

  it('1. Happy Path: Lock -> Release', async () => {
    const lockRes = await escrow.lockFunds(validParams);
    expect(lockRes.success).toBe(true);
    expect(lockRes.escrowId).toBeDefined();

    const releaseRes = await escrow.releaseFunds(validParams.taskId, lockRes.escrowId!);
    expect(releaseRes.success).toBe(true);
    expect(escrow.getStuckTransactions()).toHaveLength(0);
  });

  it('2. Idempotency: Calling lockFunds twice with same taskId returns same escrowId', async () => {
    const res1 = await escrow.lockFunds(validParams);
    const res2 = await escrow.lockFunds(validParams);

    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);
    expect(res1.escrowId).toBe(res2.escrowId);
  });

  it('3. State Machine Protection: Cannot release already refunded funds', async () => {
    const lockRes = await escrow.lockFunds(validParams);
    await escrow.refundFunds(validParams.taskId, lockRes.escrowId!, 'User cancelled');

    const releaseRes = await escrow.releaseFunds(validParams.taskId, lockRes.escrowId!);
    expect(releaseRes.success).toBe(false);
    expect(releaseRes.error).toContain('Cannot release funds from status: REFUNDED');
  });

  it('4. Reconciliation Queue: Failed operation adds task to stuck queue', async () => {
    const lockRes = await escrow.lockFunds(validParams);
    const executeWithRetry = vi
      .spyOn(escrow as never, 'executeWithRetry')
      .mockResolvedValue({
        success: false,
        error: 'Failed to refund escrow for task task-123 after 3 attempts. Last error: Network timeout',
      });

    const refundRes = await escrow.refundFunds(
      validParams.taskId,
      lockRes.escrowId!,
      'Test failure',
    );

    expect(refundRes.success).toBe(false);
    expect(executeWithRetry).toHaveBeenCalledOnce();
    expect(escrow.getStuckTransactions()).toContain(validParams.taskId);
  });
});
