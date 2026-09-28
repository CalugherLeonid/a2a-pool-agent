import type { AgentIdentity, SignedAgentCard } from '../identity/agent-identity.js';
import type { MetaToolRegistry } from './meta-tools/registry.js';
import type { TelemetryCollector } from '../telemetry/metrics.js';
import type { A2AHttpTransport } from '../adapters/a2a/http-transport.js';
import type { PeerRegistry } from '../adapters/a2a/peer-registry.js';
import type { ReputationSystem } from './reputation.js';
import { DynamicPricingEngine, type DynamicPricingConfig } from './pricing-engine.js';
import {
  type AgentCard,
  type AgentSkill,
  type AgentPerformanceMetrics,
  type CreateAgentCardOptions,
} from '../adapters/a2a/agent-card.js';
import { createLogger } from '../observability/logger.js';

export interface CardVersionRecord {
  version: string;
  buildNumber: number;
  signedCard: SignedAgentCard;
  card: AgentCard;
  reason: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface DynamicAgentCardManagerOptions {
  identity: AgentIdentity;
  metaToolRegistry?: MetaToolRegistry;
  telemetry?: TelemetryCollector;
  reputationSystem?: ReputationSystem;
  pricingEngine?: DynamicPricingEngine;
  httpTransport?: A2AHttpTransport;
  peerRegistry?: PeerRegistry;
  baseVersion?: string;
  maxHistorySize?: number;
  cardOptions?: Partial<CreateAgentCardOptions>;
}

/**
 * DynamicAgentCardManager orchestrates:
 * 1. Generating, incrementing versions, and signing (JWS Ed25519) Agent Cards dynamically.
 * 2. Pulling live skills/meta-tools from MetaToolRegistry.
 * 3. Pulling live performance telemetry metrics and ReputationSystem scores.
 * 4. Dynamically adjusting card pricing based on reputation.
 * 5. Updating /.well-known/agent-card.json on the HTTP transport.
 * 6. Notifying / updating the local PeerRegistry and external peers if configured.
 * 7. Managing version history with rollback capability.
 */
export class DynamicAgentCardManager {
  private readonly log = createLogger('dynamic-agent-card');
  private readonly identity: AgentIdentity;
  private readonly metaToolRegistry?: MetaToolRegistry;
  private readonly telemetry?: TelemetryCollector;
  private reputationSystem?: ReputationSystem;
  private pricingEngine?: DynamicPricingEngine;
  private readonly maxHistorySize: number;
  private httpTransport?: A2AHttpTransport;
  private peerRegistry?: PeerRegistry;

  private major = 1;
  private minor = 0;
  private patch = 0;
  private buildNumber = 0;

  private currentSignedCard: SignedAgentCard;
  private currentCard: AgentCard;
  private readonly versionHistory: CardVersionRecord[] = [];
  private cardOptions: Partial<CreateAgentCardOptions>;
  private unsubscribeReputation?: () => void;

  constructor(options: DynamicAgentCardManagerOptions) {
    this.identity = options.identity;
    this.metaToolRegistry = options.metaToolRegistry;
    this.telemetry = options.telemetry;
    this.reputationSystem = options.reputationSystem;
    this.pricingEngine = options.pricingEngine;
    this.httpTransport = options.httpTransport;
    this.peerRegistry = options.peerRegistry;
    this.maxHistorySize = options.maxHistorySize ?? 20;
    this.cardOptions = options.cardOptions ?? {};

    // Initialize default pricing engine if base pricing is supplied
    if (!this.pricingEngine && (this.cardOptions.defaultCostUsd || this.cardOptions.minAcceptedRewardUsd)) {
      this.pricingEngine = new DynamicPricingEngine({
        basePriceUsd: this.cardOptions.defaultCostUsd ?? 0.05,
        baseMinRewardUsd: this.cardOptions.minAcceptedRewardUsd ?? 0.05,
      });
    }

    // Parse base version if supplied (e.g. "1.0.0" -> major=1, minor=0, patch=0)
    if (options.baseVersion) {
      this.parseSemanticVersion(options.baseVersion);
    }

    // Build initial card and sign
    const initialCard = this.buildCardPayload();
    this.currentCard = initialCard;
    this.currentSignedCard = this.identity.signAgentCard(
      initialCard as unknown as Record<string, unknown>,
    );

    // Save initial record to history
    this.pushHistory({
      version: this.formatVersion(),
      buildNumber: this.buildNumber,
      signedCard: this.currentSignedCard,
      card: this.currentCard,
      reason: 'initialization',
      timestamp: new Date().toISOString(),
    });

    // Synchronize initial card with HTTP transport if already present
    if (this.httpTransport) {
      this.httpTransport.setSignedAgentCard(this.currentSignedCard);
    }

    // Subscribe to reputation updates
    this.subscribeToReputation();
  }

  /**
   * Sets or updates the HTTP transport reference.
   */
  public setHttpTransport(transport: A2AHttpTransport): void {
    this.httpTransport = transport;
    this.httpTransport.setSignedAgentCard(this.currentSignedCard);
  }

  /**
   * Sets or updates the PeerRegistry reference.
   */
  public setPeerRegistry(registry: PeerRegistry): void {
    this.peerRegistry = registry;
    // Register self in peer registry as well
    this.peerRegistry.registerPeer(this.currentSignedCard);
  }

  /**
   * Increments semantic version based on bump type and advances buildNumber.
   */
  public bumpVersion(type: 'patch' | 'minor' | 'major' = 'patch'): string {
    if (type === 'major') {
      this.major++;
      this.minor = 0;
      this.patch = 0;
    } else if (type === 'minor') {
      this.minor++;
      this.patch = 0;
    } else {
      this.patch++;
    }
    this.buildNumber++;
    return this.formatVersion();
  }

  public getVersion(): string {
    return this.formatVersion();
  }

  public getBuildNumber(): number {
    return this.buildNumber;
  }

  public getCurrentCard(): AgentCard {
    return this.currentCard;
  }

  public getSignedAgentCard(): SignedAgentCard {
    return this.currentSignedCard;
  }

  public getVersionHistory(): CardVersionRecord[] {
    return [...this.versionHistory];
  }

  /**
   * Exports full version history for persistence.
   */
  public exportHistory(): CardVersionRecord[] {
    return [...this.versionHistory];
  }

  /**
   * Imports previously persisted card version history and optionally restores latest.
   */
  public importHistory(history: CardVersionRecord[], restoreLatest = true): void {
    if (!Array.isArray(history) || history.length === 0) return;
    this.versionHistory.length = 0;
    for (const rec of history) {
      if (rec && typeof rec === 'object' && rec.version && rec.signedCard && rec.card) {
        this.versionHistory.push(rec);
      }
    }

    if (restoreLatest && this.versionHistory.length > 0) {
      const latest = this.versionHistory[0]!;
      this.currentCard = latest.card;
      this.currentSignedCard = latest.signedCard;
      this.parseSemanticVersion(latest.version);
      this.buildNumber = latest.buildNumber;

      if (this.httpTransport) {
        this.httpTransport.setSignedAgentCard(this.currentSignedCard);
      }
      if (this.peerRegistry) {
        this.peerRegistry.registerPeer(this.currentSignedCard);
      }
    }
  }

  /**
   * Regenerates, re-versions, and re-signs the Agent Card.
   * Updates HTTP endpoint and notifies Peer Registry.
   */
  public updateCard(options: {
    reason: string;
    bumpType?: 'patch' | 'minor' | 'major';
    metadata?: Record<string, unknown>;
  }): {
    success: boolean;
    version: string;
    buildNumber: number;
    signedCard: SignedAgentCard;
    card: AgentCard;
  } {
    const bumpType = options.bumpType ?? 'patch';
    const newVersion = this.bumpVersion(bumpType);

    this.log.info(
      { version: newVersion, buildNumber: this.buildNumber, reason: options.reason },
      'regenerating and signing updated dynamic Agent Card',
    );

    // 1. Build updated card with new version, skills and live metrics
    const updatedCard = this.buildCardPayload();
    this.currentCard = updatedCard;

    // 2. Re-sign card with Zero-Trust Ed25519 (JWS)
    this.currentSignedCard = this.identity.signAgentCard(
      updatedCard as unknown as Record<string, unknown>,
    );

    // 3. Record in version history
    const record: CardVersionRecord = {
      version: newVersion,
      buildNumber: this.buildNumber,
      signedCard: this.currentSignedCard,
      card: updatedCard,
      reason: options.reason,
      timestamp: new Date().toISOString(),
      metadata: options.metadata,
    };
    this.pushHistory(record);

    // 4. Update /.well-known/agent-card.json on HTTP transport
    if (this.httpTransport) {
      this.httpTransport.setSignedAgentCard(this.currentSignedCard);
    }

    // 5. Notify/update PeerRegistry
    if (this.peerRegistry) {
      this.peerRegistry.registerPeer(this.currentSignedCard);
    }

    return {
      success: true,
      version: newVersion,
      buildNumber: this.buildNumber,
      signedCard: this.currentSignedCard,
      card: updatedCard,
    };
  }

  /**
   * Rolls back the Agent Card to an earlier version in the history.
   */
  public rollback(targetVersionOrBuild: string | number): {
    success: boolean;
    version?: string;
    error?: string;
  } {
    const found = this.versionHistory.find((rec) =>
      typeof targetVersionOrBuild === 'number'
        ? rec.buildNumber === targetVersionOrBuild
        : rec.version === targetVersionOrBuild,
    );

    if (!found) {
      return {
        success: false,
        error: `Version or build '${targetVersionOrBuild}' not found in history`,
      };
    }

    this.log.info(
      { target: targetVersionOrBuild, version: found.version, build: found.buildNumber },
      'rolling back Agent Card to previous version',
    );

    this.currentCard = found.card;
    this.currentSignedCard = found.signedCard;
    this.parseSemanticVersion(found.version);
    this.buildNumber = found.buildNumber;

    // Record rollback action in history
    this.pushHistory({
      version: this.formatVersion(),
      buildNumber: this.buildNumber,
      signedCard: this.currentSignedCard,
      card: this.currentCard,
      reason: `rollback to ${found.version} (build ${found.buildNumber})`,
      timestamp: new Date().toISOString(),
    });

    // Sync with transports
    if (this.httpTransport) {
      this.httpTransport.setSignedAgentCard(this.currentSignedCard);
    }
    if (this.peerRegistry) {
      this.peerRegistry.registerPeer(this.currentSignedCard);
    }

    return {
      success: true,
      version: this.formatVersion(),
    };
  }

  /**
   * Sets or updates the ReputationSystem reference and subscribes to score changes.
   */
  public setReputationSystem(reputationSystem: ReputationSystem): void {
    if (this.unsubscribeReputation) {
      this.unsubscribeReputation();
      this.unsubscribeReputation = undefined;
    }
    this.reputationSystem = reputationSystem;
    this.subscribeToReputation();
  }

  /**
   * Subscribes to the reputation system to automatically update the Agent Card
   * whenever the local agent's reputation or pricing changes.
   */
  private subscribeToReputation(): void {
    if (!this.reputationSystem) return;
    this.unsubscribeReputation = this.reputationSystem.onUpdate((agentId, newScore) => {
      if (agentId === this.identity.agentId || agentId === 'self') {
        const oldScore = this.currentCard.performanceMetrics?.reputationScore;
        const currentPricing = this.pricingEngine?.calculatePricing(newScore);
        const oldPrice = this.currentCard.pricing.defaultCostUsd ?? 0.05;
        const priceChanged =
          currentPricing !== undefined &&
          Math.abs(currentPricing.defaultCostUsd - oldPrice) > 0.0001;
        const scoreChanged =
          oldScore === undefined || Math.abs(oldScore - newScore) > 0.001;

        if (scoreChanged || priceChanged) {
          this.updateCard({
            reason: `reputation_update:${newScore.toFixed(3)}${priceChanged ? ':price_adjusted' : ''}`,
            bumpType: 'patch',
            metadata: {
              reputationScore: newScore,
              pricing: currentPricing,
            },
          });
        }
      }
    });
  }

  /**
   * Manually syncs the Agent Card with the latest reputation score.
   */
  public syncWithReputation(): { updated: boolean; version?: string } {
    if (!this.reputationSystem) return { updated: false };
    const currentScore = this.reputationSystem.getScore(this.identity.agentId);
    const oldScore = this.currentCard.performanceMetrics?.reputationScore;
    if (oldScore === undefined || Math.abs(oldScore - currentScore) > 0.001) {
      const res = this.updateCard({
        reason: `manual_sync_reputation:${currentScore.toFixed(3)}`,
        bumpType: 'patch',
      });
      return { updated: true, version: res.version };
    }
    return { updated: false, version: this.formatVersion() };
  }

  /**
   * Adjusts pricing configuration or base prices and immediately regenerates
   * and re-signs the Agent Card with Ed25519.
   */
  public updatePricing(options: {
    basePriceUsd?: number;
    baseMinRewardUsd?: number;
    rules?: Partial<DynamicPricingConfig>;
    reason?: string;
  }): {
    version: string;
    card: AgentCard;
    signedCard: SignedAgentCard;
  } {
    if (!this.pricingEngine) {
      this.pricingEngine = new DynamicPricingEngine({
        basePriceUsd: options.basePriceUsd ?? 0.05,
        baseMinRewardUsd: options.baseMinRewardUsd ?? 0.05,
        ...(options.rules ?? {}),
      });
    } else {
      if (options.rules) {
        this.pricingEngine.updateRules(options.rules);
      }
      if (options.basePriceUsd !== undefined) {
        this.pricingEngine.updateBasePrices(options.basePriceUsd, options.baseMinRewardUsd);
      }
    }

    const res = this.updateCard({
      reason: options.reason ?? 'pricing_adjusted',
      bumpType: 'patch',
      metadata: {
        pricingUpdate: options,
      },
    });

    return {
      version: res.version,
      card: res.card,
      signedCard: res.signedCard,
    };
  }

  /**
   * Sets or updates the DynamicPricingEngine reference.
   */
  public setPricingEngine(pricingEngine: DynamicPricingEngine): void {
    this.pricingEngine = pricingEngine;
  }

  /**
   * Helper that builds the full AgentCard object.
   */
  private buildCardPayload(): AgentCard {
    const versionStr = this.formatVersion();

    // 1. Collect skills from MetaToolRegistry
    const skills: AgentSkill[] = [];
    if (this.metaToolRegistry) {
      const latestTools = this.metaToolRegistry.listLatest();
      for (const tool of latestTools) {
        skills.push({
          id: tool.id,
          name: tool.name,
          description: tool.description,
          version: tool.version,
          parametersSchema: tool.parametersSchema,
        });
      }
    }

    // 2. Determine reputation score (from ReputationSystem if present, else TelemetryCollector)
    let reputationScore = 1.0;
    if (this.reputationSystem) {
      reputationScore = this.reputationSystem.getScore(this.identity.agentId);
    } else if (this.telemetry) {
      const agg = this.telemetry.getAggregatedMetrics();
      reputationScore =
        agg.totalExecutions > 0
          ? Math.max(0, Math.min(1, (agg.totalExecutions - agg.ratchetRejectedCount) / agg.totalExecutions))
          : 1.0;
    }

    // 3. Collect performance metrics from TelemetryCollector
    let performanceMetrics: AgentPerformanceMetrics | undefined;
    if (this.telemetry) {
      const agg = this.telemetry.getAggregatedMetrics();
      performanceMetrics = {
        uptimeSeconds: Math.floor(process.uptime()),
        totalDeliveries: agg.totalExecutions,
        averageLatencyMs: Math.round(agg.averageLatencyMs),
        reputationScore: parseFloat(reputationScore.toFixed(3)),
        system1HitRatio: parseFloat(agg.system1HitRate.toFixed(3)),
      };
    }

    // 4. Calculate dynamic pricing based on reputation
    let defaultCostUsd = this.cardOptions.defaultCostUsd ?? 0.05;
    let minAcceptedRewardUsd = this.cardOptions.minAcceptedRewardUsd ?? 0.05;

    if (this.pricingEngine) {
      const calculated = this.pricingEngine.calculatePricing(reputationScore);
      defaultCostUsd = calculated.defaultCostUsd;
      minAcceptedRewardUsd = calculated.minAcceptedRewardUsd;
    }

    const cleanPubKey = this.identity
      .getPublicKeyPem()
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '');

    const capabilities = [
      'text-generation',
      'code-synthesis',
      'data-analysis',
      'summarization',
      'cryptographic-signing',
      'system1-fast-path',
      'system2-evolution',
      'meta-tools',
      ...skills.map((s) => s.id),
    ];

    return {
      schemaVersion: '1.0.0',
      id: this.identity.agentId,
      name: this.cardOptions.name ?? this.identity.agentId,
      version: versionStr,
      description:
        this.cardOptions.description ??
        'Autonomous multi-marketplace A2A pool agent with dynamic self-modifying capabilities (Morphling).',
      identity: {
        type: 'ed25519',
        algorithm: 'Ed25519',
        publicKey: cleanPubKey,
        publicKeyPem: this.identity.getPublicKeyPem(),
        publicKeyHex: this.identity.getPublicKeyHex(),
        keyVersion: this.identity.getKeyVersion(),
      },
      capabilities: Array.from(new Set(capabilities)),
      supportedTaskTypes: [
        'prompt-completion',
        'code-generation',
        'classification',
        'structured-json-output',
        'meta_tool',
        'a2a_service',
      ],
      skills,
      pricing: {
        minAcceptedRewardUsd,
        defaultCostUsd,
        acceptedCurrencies: this.cardOptions.acceptedCurrencies ?? ['USD', 'USDT', 'USDC'],
        paymentProtocols: ['escrow', 'direct-transfer', 'web3-receipt'],
      },
      endpoints: this.cardOptions.endpoints ?? {
        http: 'http://localhost:3000/a2a',
        ws: 'ws://localhost:3000/a2a/ws',
        wellKnown: 'http://localhost:3000/.well-known/agent-card.json',
      },
      performanceMetrics: performanceMetrics ?? {
        uptimeSeconds: Math.floor(process.uptime()),
        totalDeliveries: 0,
        averageLatencyMs: 0,
        reputationScore: parseFloat(reputationScore.toFixed(3)),
        system1HitRatio: 0.0,
      },
      runtime: {
        maxTimeoutSeconds: this.cardOptions.maxTimeoutSeconds ?? 120,
        preferredModel: this.cardOptions.preferredModel ?? 'gemini-1.5-flash',
      },
    };
  }

  private parseSemanticVersion(v: string): void {
    const clean = v.replace(/^v/, '');
    const parts = clean.split('.');
    if (parts.length >= 1 && !isNaN(Number(parts[0]))) {
      this.major = Number(parts[0]);
    }
    if (parts.length >= 2 && !isNaN(Number(parts[1]))) {
      this.minor = Number(parts[1]);
    }
    if (parts.length >= 3 && !isNaN(Number(parts[2]))) {
      this.patch = Number(parts[2]);
    }
  }

  private formatVersion(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  }

  private pushHistory(record: CardVersionRecord): void {
    this.versionHistory.unshift(record);
    if (this.versionHistory.length > this.maxHistorySize) {
      this.versionHistory.pop();
    }
  }
}
