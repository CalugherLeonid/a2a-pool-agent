/**
 * Robust Atomic State Persistence Manager for Production Readiness.
 *
 * Persists and hydrates critical runtime states to/from disk using safe atomic writes
 * (write to temp file then atomic rename) to guarantee zero corruption on unexpected shutdowns:
 *   - Reputation system records and history
 *   - Escrow transactions and status records
 *   - Dynamic Agent Card version history
 *   - Aggregated telemetry metrics
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../observability/logger.js';
import type { ReputationSystem } from '../core/reputation.js';
import type { EscrowSystem } from '../core/escrow.js';
import type { DynamicAgentCardManager } from '../core/dynamic-agent-card.js';
import type { TelemetryCollector } from '../telemetry/metrics.js';
import { env } from '../config/env.js';

export interface StatePersistenceOptions {
  storageDir?: string;
}

export interface PersistenceBundle {
  reputation?: ReputationSystem;
  escrow?: EscrowSystem;
  cardManager?: DynamicAgentCardManager;
  telemetry?: TelemetryCollector;
}

export class StatePersistenceManager {
  private readonly log = createLogger('state-persistence');
  private readonly storageDir: string;

  constructor(options?: StatePersistenceOptions) {
    this.storageDir = path.resolve(options?.storageDir ?? env.STATE_PERSISTENCE_DIR ?? './data/state');
    this.ensureDirSync();
  }

  public getStateDir(): string {
    return this.storageDir;
  }

  private ensureDirSync(): void {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
    } catch (err) {
      this.log.error({ err, dir: this.storageDir }, 'failed to create state persistence directory');
    }
  }

  /**
   * Safely writes data to a file atomically via temp-file write + rename.
   */
  public async writeAtomic(filename: string, content: string): Promise<void> {
    this.ensureDirSync();
    const targetPath = path.join(this.storageDir, filename);
    const tmpPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2, 8)}`;

    try {
      await fs.promises.writeFile(tmpPath, content, 'utf-8');
      await fs.promises.rename(tmpPath, targetPath);
      this.log.debug({ file: filename }, 'atomic write succeeded');
    } catch (err) {
      this.log.error({ err, file: filename }, 'atomic write failed');
      // Clean up orphaned temp file if needed
      try {
        if (fs.existsSync(tmpPath)) {
          await fs.promises.unlink(tmpPath);
        }
      } catch {}
      throw err;
    }
  }

  /**
   * Safely reads JSON from a file, returning null if file does not exist or is invalid.
   */
  public async readJson<T>(filename: string): Promise<T | null> {
    const targetPath = path.join(this.storageDir, filename);
    try {
      if (!fs.existsSync(targetPath)) {
        return null;
      }
      const raw = await fs.promises.readFile(targetPath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (err) {
      this.log.warn({ err, file: filename }, 'failed to read or parse state file');
      return null;
    }
  }

  // --- Reputation System ---

  public async saveReputation(reputation: ReputationSystem): Promise<void> {
    const state = reputation.exportState();
    await this.writeAtomic('reputation.json', JSON.stringify(state, null, 2));
    this.log.info({ agents: Object.keys(state).length }, 'reputation state saved');
  }

  public async loadReputation(reputation: ReputationSystem): Promise<boolean> {
    const state = await this.readJson<Parameters<typeof reputation.importState>[0]>('reputation.json');
    if (!state) return false;
    reputation.importState(state);
    this.log.info({ agents: Object.keys(state).length }, 'reputation state hydrated');
    return true;
  }

  // --- Escrow System ---

  public async saveEscrow(escrow: EscrowSystem): Promise<void> {
    const records = escrow.exportState();
    await this.writeAtomic('escrow.json', JSON.stringify(records, null, 2));
    this.log.info({ count: records.length }, 'escrow records saved');
  }

  public async loadEscrow(escrow: EscrowSystem): Promise<boolean> {
    const records = await this.readJson<Parameters<typeof escrow.importState>[0]>('escrow.json');
    if (!records) return false;
    escrow.importState(records);
    this.log.info({ count: records.length }, 'escrow records hydrated');
    return true;
  }

  // --- Agent Card Version History ---

  public async saveCardHistory(cardManager: DynamicAgentCardManager): Promise<void> {
    const history = cardManager.exportHistory();
    await this.writeAtomic('agent-card-history.json', JSON.stringify(history, null, 2));
    this.log.info({ count: history.length }, 'agent card history saved');
  }

  public async loadCardHistory(cardManager: DynamicAgentCardManager): Promise<boolean> {
    const history = await this.readJson<Parameters<typeof cardManager.importHistory>[0]>('agent-card-history.json');
    if (!history) return false;
    cardManager.importHistory(history);
    this.log.info({ count: history.length }, 'agent card history hydrated');
    return true;
  }

  // --- Telemetry State ---

  public async saveTelemetry(telemetry: TelemetryCollector): Promise<void> {
    const state = telemetry.exportState();
    await this.writeAtomic('telemetry.json', JSON.stringify(state, null, 2));
    this.log.info('telemetry state saved');
  }

  public async loadTelemetry(telemetry: TelemetryCollector): Promise<boolean> {
    const state = await this.readJson<Parameters<typeof telemetry.importState>[0]>('telemetry.json');
    if (!state) return false;
    telemetry.importState(state);
    this.log.info('telemetry state hydrated');
    return true;
  }

  // --- Bundle Operations ---

  public async saveAll(bundle: PersistenceBundle): Promise<void> {
    const promises: Promise<void>[] = [];
    if (bundle.reputation) promises.push(this.saveReputation(bundle.reputation));
    if (bundle.escrow) promises.push(this.saveEscrow(bundle.escrow));
    if (bundle.cardManager) promises.push(this.saveCardHistory(bundle.cardManager));
    if (bundle.telemetry) promises.push(this.saveTelemetry(bundle.telemetry));
    await Promise.all(promises);
    this.log.info('all configured state components persisted successfully');
  }

  public async loadAll(bundle: PersistenceBundle): Promise<{
    reputation: boolean;
    escrow: boolean;
    cardManager: boolean;
    telemetry: boolean;
  }> {
    const [reputation, escrow, cardManager, telemetry] = await Promise.all([
      bundle.reputation ? this.loadReputation(bundle.reputation) : Promise.resolve(false),
      bundle.escrow ? this.loadEscrow(bundle.escrow) : Promise.resolve(false),
      bundle.cardManager ? this.loadCardHistory(bundle.cardManager) : Promise.resolve(false),
      bundle.telemetry ? this.loadTelemetry(bundle.telemetry) : Promise.resolve(false),
    ]);

    return { reputation, escrow, cardManager, telemetry };
  }

  /**
   * Cleans all state files (useful for tests).
   */
  public async clear(): Promise<void> {
    try {
      if (fs.existsSync(this.storageDir)) {
        const files = await fs.promises.readdir(this.storageDir);
        for (const file of files) {
          if (file.endsWith('.json') || file.includes('.tmp.')) {
            await fs.promises.unlink(path.join(this.storageDir, file));
          }
        }
      }
    } catch (err) {
      this.log.warn({ err }, 'error clearing state directory');
    }
  }
}
