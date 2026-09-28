import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { StatePersistenceManager } from './state-persistence.js';
import { ReputationSystem } from '../core/reputation.js';
import { EscrowSystem } from '../core/escrow.js';
import { DynamicAgentCardManager } from '../core/dynamic-agent-card.js';
import { TelemetryCollector } from '../telemetry/metrics.js';
import { AgentIdentity } from '../identity/agent-identity.js';

const TEST_DIR = path.resolve('./data/test-state-' + Date.now());

describe('StatePersistenceManager - Atomic Robust Persistence', () => {
  let persistence: StatePersistenceManager;

  beforeEach(() => {
    persistence = new StatePersistenceManager({ storageDir: TEST_DIR });
  });

  afterEach(async () => {
    await persistence.clear();
    try {
      if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
    } catch {}
  });

  it('salvează fișiere atomic fără fișiere temporare rămase', async () => {
    const filename = 'atomic-test.json';
    const payload = JSON.stringify({ hello: 'world', timestamp: Date.now() });

    await persistence.writeAtomic(filename, payload);

    const fullPath = path.join(TEST_DIR, filename);
    expect(fs.existsSync(fullPath)).toBe(true);
    const content = fs.readFileSync(fullPath, 'utf-8');
    expect(content).toBe(payload);

    // Verifică că nu au rămas fișiere .tmp
    const files = fs.readdirSync(TEST_DIR);
    const tmpFiles = files.filter((f) => f.includes('.tmp.'));
    expect(tmpFiles.length).toBe(0);
  });

  it('salvează și restaurează corect istoricul de reputație', async () => {
    const reputation1 = new ReputationSystem();
    reputation1.recordFeedback({
      taskId: 'task-100',
      agentId: 'peer-alice',
      success: true,
      latencyMs: 120,
      deadlineMs: 500,
      evalScore: 0.95,
      ratchetAccepted: true,
    });
    reputation1.recordFeedback({
      taskId: 'task-101',
      agentId: 'peer-alice',
      success: false,
      latencyMs: 800,
      deadlineMs: 500,
      evalScore: 0.2,
      ratchetAccepted: false,
    });

    const aliceScoreBefore = reputation1.getScore('peer-alice');
    const aliceRecordBefore = reputation1.getRecord('peer-alice');
    expect(aliceRecordBefore?.totalTasks).toBe(2);

    // Salvează
    await persistence.saveReputation(reputation1);

    // Restaurează într-o instanță nouă
    const reputation2 = new ReputationSystem();
    expect(reputation2.getRecord('peer-alice')).toBeUndefined();

    const loaded = await persistence.loadReputation(reputation2);
    expect(loaded).toBe(true);

    const aliceScoreAfter = reputation2.getScore('peer-alice');
    const aliceRecordAfter = reputation2.getRecord('peer-alice');

    expect(aliceScoreAfter).toBeCloseTo(aliceScoreBefore, 4);
    expect(aliceRecordAfter?.totalTasks).toBe(2);
    expect(aliceRecordAfter?.successfulTasks).toBe(1);
    expect(aliceRecordAfter?.history.length).toBe(2);
  });

  it('salvează și restaurează corect înregistrările de escrow', async () => {
    const mockTelemetry = {
      recordEscrowEvent: () => {},
    } as any;
    const escrow1 = new EscrowSystem(3, mockTelemetry);

    const lock1 = await escrow1.lockFunds({ taskId: 'task-escrow-1', amount: 1.5, from: 'agent-client', to: 'agent-provider' });
    await escrow1.releaseFunds('task-escrow-1', lock1.escrowId!);

    const lock2 = await escrow1.lockFunds({ taskId: 'task-escrow-2', amount: 2.0, from: 'agent-client', to: 'agent-provider' });
    await escrow1.refundFunds('task-escrow-2', lock2.escrowId!, 'timeout');

    // Salvează
    await persistence.saveEscrow(escrow1);

    // Restaurează într-o nouă instanță
    const escrow2 = new EscrowSystem(3, mockTelemetry);
    expect(escrow2.getAllRecords().length).toBe(0);

    const loaded = await persistence.loadEscrow(escrow2);
    expect(loaded).toBe(true);

    const rec1 = escrow2.getRecordByTaskId('task-escrow-1');
    const rec2 = escrow2.getRecordByTaskId('task-escrow-2');

    expect(rec1).toBeDefined();
    expect(rec1?.status).toBe('RELEASED');
    expect(rec1?.amount).toBe(1.5);

    expect(rec2).toBeDefined();
    expect(rec2?.status).toBe('REFUNDED');
    expect(rec2?.failureReason).toBe('timeout');
  });

  it('salvează și restaurează istoricul versiunilor Dynamic Agent Card', async () => {
    const identity = AgentIdentity.create('agent-test-identity');
    const cardManager1 = new DynamicAgentCardManager({
      identity,
      baseVersion: '1.0.0',
    });

    // Face două actualizări
    cardManager1.updateCard({ reason: 'feature_added', bumpType: 'minor' });
    cardManager1.updateCard({ reason: 'hotfix_patch', bumpType: 'patch' });

    expect(cardManager1.getVersion()).toBe('1.1.1');
    const historyBefore = cardManager1.exportHistory();
    expect(historyBefore.length).toBe(3);

    // Salvează
    await persistence.saveCardHistory(cardManager1);

    // Restaurează într-o instanță nouă
    const cardManager2 = new DynamicAgentCardManager({
      identity,
      baseVersion: '1.0.0',
    });

    const loaded = await persistence.loadCardHistory(cardManager2);
    expect(loaded).toBe(true);

    const historyAfter = cardManager2.exportHistory();
    expect(historyAfter.length).toBe(3);
    expect(cardManager2.getVersion()).toBe('1.1.1');
  });

  it('salvează și restaurează metricile agregate de telemetrie', async () => {
    const telemetry1 = new TelemetryCollector();
    telemetry1.recordTask(true);
    telemetry1.recordExecution(
      {
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        tokensIn: 100,
        tokensOut: 200,
        costUsd: 0.005,
        latencyMs: 350,
        fallbackUsed: false,
        fallbackChain: ['gemini'],
        systemPath: 'system2',
        timestamp: new Date().toISOString(),
      },
      true,
    );

    // Salvează
    await persistence.saveTelemetry(telemetry1);

    // Restaurează într-o instanță nouă
    const telemetry2 = new TelemetryCollector();
    const loaded = await persistence.loadTelemetry(telemetry2);
    expect(loaded).toBe(true);

    const exported = telemetry2.exportState();
    expect(exported.metrics.totalTasks).toBe(1);
    expect(exported.metrics.acceptedTasks).toBe(1);
  });

  it('salvează și încarcă bundle-ul complet cu saveAll / loadAll', async () => {
    const identity = AgentIdentity.create('agent-bundle');
    const reputation = new ReputationSystem();
    const escrow = new EscrowSystem(3, { recordEscrowEvent: () => {} } as any);
    const cardManager = new DynamicAgentCardManager({ identity, baseVersion: '1.0.0' });
    const telemetry = new TelemetryCollector();

    reputation.recordFeedback({
      taskId: 't-1',
      agentId: 'peer-bob',
      success: true,
      latencyMs: 50,
      deadlineMs: 200,
    });

    await escrow.lockFunds({ taskId: 't-1', amount: 1.0, from: 'alice', to: 'bob' });

    await persistence.saveAll({
      reputation,
      escrow,
      cardManager,
      telemetry,
    });

    // Reîncarcă într-un nou bundle
    const newReputation = new ReputationSystem();
    const newEscrow = new EscrowSystem(3, { recordEscrowEvent: () => {} } as any);
    const newCardManager = new DynamicAgentCardManager({ identity, baseVersion: '1.0.0' });
    const newTelemetry = new TelemetryCollector();

    const results = await persistence.loadAll({
      reputation: newReputation,
      escrow: newEscrow,
      cardManager: newCardManager,
      telemetry: newTelemetry,
    });

    expect(results.reputation).toBe(true);
    expect(results.escrow).toBe(true);
    expect(results.cardManager).toBe(true);
    expect(results.telemetry).toBe(true);

    expect(newReputation.getRecord('peer-bob')?.totalTasks).toBe(1);
    expect(newEscrow.getRecordByTaskId('t-1')).toBeDefined();
  });

  it('gestionează sigur fișiere inexistente sau corupte fără crash', async () => {
    const emptyPersistence = new StatePersistenceManager({
      storageDir: path.join(TEST_DIR, 'non-existent-subfolder'),
    });

    const reputation = new ReputationSystem();
    const loadedMissing = await emptyPersistence.loadReputation(reputation);
    expect(loadedMissing).toBe(false);

    // Scrie JSON invalid
    const corruptFile = path.join(TEST_DIR, 'reputation.json');
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(corruptFile, '{ invalid json corrupted content');

    const loadedCorrupt = await persistence.loadReputation(reputation);
    expect(loadedCorrupt).toBe(false);
  });
});
