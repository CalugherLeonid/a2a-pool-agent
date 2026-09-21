import { describe, it, expect } from 'vitest';
import { OKXMarketplaceAdapter } from './index.js';
import { loadSignerFromPemPath } from '../../../identity/ed25519.js';

describe('OKX Marketplace Adapter', () => {
  const signer = loadSignerFromPemPath('/tmp/test-okx-agent.key');

  it('polls tasks and returns normalized Task interface', async () => {
    const adapter = new OKXMarketplaceAdapter(signer);
    const tasks = await adapter.pollTasks();

    expect(tasks.length).toBeGreaterThan(0);
    const task = tasks[0]!;
    expect(task.marketplace).toBe('okx');
    expect(task.reward).toBeGreaterThan(0);
    expect(task.currency).toBe('USDT');
    expect(task.prompt).toBeDefined();
  });

  it('submits artifact with Ed25519 signature and receives settlement receipt', async () => {
    const adapter = new OKXMarketplaceAdapter(signer);
    const artifact = {
      content: 'Analysis report on Arbitrum liquidity',
      model: 'gemini-1.5-flash',
      completedAt: new Date().toISOString(),
    };

    const receipt = await adapter.submitArtifact('test-task-123', artifact);

    expect(receipt.success).toBe(true);
    expect(receipt.taskId).toBe('test-task-123');
    expect(receipt.settlementId).toMatch(/^0x/);
  });

  it('generates standardized Agent Card with Ed25519 identity', () => {
    const adapter = new OKXMarketplaceAdapter(signer);
    const card = adapter.getAgentCard();

    expect(card.schemaVersion).toBe('1.0.0');
    expect(card.identity.type).toBe('ed25519');
    expect(card.identity.publicKey.length).toBeGreaterThan(10);
    expect(card.pricing.acceptedCurrencies).toContain('USDT');
  });
});
