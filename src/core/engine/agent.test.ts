import { describe, it, expect } from 'vitest';
import { AgentEngine } from './agent.js';
import { loadSignerFromPemPath } from '../../identity/ed25519.js';
import type { MarketplaceAdapter, Task, TaskArtifact, SubmissionReceipt } from '../../adapters/interface.js';
import { generateAgentCard } from '../../adapters/a2a/agent-card.js';

class MockTestAdapter implements MarketplaceAdapter {
  readonly id = 'test-marketplace';
  private tasks: Task[] = [];
  public submittedArtifacts: Array<{ taskId: string; signature: string }> = [];

  constructor(initialTasks: Task[]) {
    this.tasks = initialTasks;
  }

  async pollTasks(): Promise<Task[]> {
    const batch = [...this.tasks];
    this.tasks = [];
    return batch;
  }

  async submitArtifact(
    taskId: string,
    _artifact: TaskArtifact,
    signature: string,
  ): Promise<SubmissionReceipt> {
    this.submittedArtifacts.push({ taskId, signature });
    return {
      success: true,
      taskId,
      settlementId: `0xsettle-${taskId}`,
      submittedAt: new Date().toISOString(),
    };
  }

  getAgentCard() {
    return generateAgentCard({
      agentId: 'test-agent',
      name: 'Test Agent',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEADkUa+2aYZG3EVRzWiL9asB3YhN65lxyj3pz6sxfNh1c=\n-----END PUBLIC KEY-----',
    });
  }
}

describe('Autonomous Agent Engine Core Loop', () => {
  const signer = loadSignerFromPemPath('/tmp/test-engine-agent.key');

  it('processes profitable task end-to-end: triage -> execution -> quality -> signing -> settlement', async () => {
    const profitableTask: Task = {
      id: 'task-profitable-1',
      marketplace: 'test-marketplace',
      prompt: 'Summarize blockchain scaling techniques.',
      reward: 0.80, // $0.80 reward
      currency: 'USDT',
    };

    const adapter = new MockTestAdapter([profitableTask]);
    const engine = new AgentEngine({
      signer,
      adapters: [adapter],
    });

    const success = await engine.processTask(adapter, profitableTask);
    expect(success).toBe(true);
    expect(adapter.submittedArtifacts.length).toBe(1);
    expect(adapter.submittedArtifacts[0]!.taskId).toBe('task-profitable-1');
    expect(adapter.submittedArtifacts[0]!.signature).toMatch(/^ed25519:/);
  });

  it('rejects unprofitable task during economic triage without execution or signing', async () => {
    const unprofitableTask: Task = {
      id: 'task-unprofitable-2',
      marketplace: 'test-marketplace',
      prompt: 'A'.repeat(50000), // Huge prompt -> high cost
      reward: 0.0001, // $0.0001 reward -> negative EV
      currency: 'USDT',
    };

    const adapter = new MockTestAdapter([unprofitableTask]);
    const engine = new AgentEngine({
      signer,
      adapters: [adapter],
    });

    const success = await engine.processTask(adapter, unprofitableTask);
    expect(success).toBe(false);
    expect(adapter.submittedArtifacts.length).toBe(0);
  });

  it('can start and stop the daemon cleanly', async () => {
    const adapter = new MockTestAdapter([]);
    const engine = new AgentEngine({
      signer,
      adapters: [adapter],
      pollIntervalMs: 50,
    });

    await engine.start();
    await new Promise((r) => setTimeout(r, 120));
    await engine.stop();
  });
});
