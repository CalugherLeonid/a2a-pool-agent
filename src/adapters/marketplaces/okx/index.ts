/**
 * OKX Web3 Marketplace Adapter.
 *
 * Implements MarketplaceAdapter to interact with OKX Web3 Agent Economy.
 * Handles task ingestion (pay-per-task) and Ed25519 payload signing for settlement.
 */

import type {
  MarketplaceAdapter,
  Task,
  TaskArtifact,
  SubmissionReceipt,
} from '../../interface.js';
import { generateAgentCard, type AgentCard } from '../../a2a/agent-card.js';
import { OKXWeb3Client, type OKXClientConfig } from './client.js';
import { canonicalJson, type Signer } from '../../../identity/ed25519.js';

export interface OKXAdapterConfig {
  agentId?: string;
  agentName?: string;
  clientConfig?: OKXClientConfig;
  minAcceptedRewardUsd?: number;
}

export class OKXMarketplaceAdapter implements MarketplaceAdapter {
  public readonly id = 'okx';
  private readonly client: OKXWeb3Client;
  private readonly signer: Signer;
  private readonly agentId: string;
  private readonly agentName: string;
  private readonly minAcceptedRewardUsd: number;

  constructor(signer: Signer, config?: OKXAdapterConfig) {
    this.signer = signer;
    this.client = new OKXWeb3Client(config?.clientConfig);
    this.agentId = config?.agentId ?? 'a2a-agent-okx';
    this.agentName = config?.agentName ?? 'A2A OKX Autonomous Agent';
    this.minAcceptedRewardUsd = config?.minAcceptedRewardUsd ?? 0.1;
  }

  /**
   * Polls OKX Web3 marketplace for tasks matching economic criteria.
   */
  async pollTasks(): Promise<Task[]> {
    const rawTasks = await this.client.fetchAvailableTasks();

    return rawTasks.map((raw) => ({
      id: raw.id,
      marketplace: this.id,
      prompt: raw.prompt,
      reward: parseFloat(raw.rewardAmount),
      currency: raw.rewardToken,
      deadline: new Date(Date.now() + raw.timeoutSeconds * 1000).toISOString(),
      metadata: {
        creator: raw.creator,
        escrowContract: raw.escrowContract,
        timeoutSeconds: raw.timeoutSeconds,
      },
    }));
  }

  /**
   * Submits completed artifact signed with Ed25519 to OKX for on-chain / escrow payout.
   */
  async submitArtifact(
    taskId: string,
    artifact: TaskArtifact,
    signature?: string,
  ): Promise<SubmissionReceipt> {
    // 1. Serialize artifact to canonical JSON for cryptographic determinism
    const canonicalPayload = canonicalJson(artifact);

    // 2. Sign with Ed25519 if an external signature is not already supplied
    const finalSignature = signature ?? this.signer.sign(canonicalPayload);

    // 3. Dispatch settlement payload to OKX Web3
    const receipt = await this.client.submitSettlement({
      taskId,
      artifact,
      signature: finalSignature,
      signerPublicKey: this.signer.pubkeyPem(),
      submittedAt: new Date().toISOString(),
    });

    return {
      success: receipt.success,
      taskId: receipt.taskId,
      settlementId: receipt.txHash,
      submittedAt: receipt.settledAt,
    };
  }

  /**
   * Returns the canonical A2A Agent Card for OKX registry discovery.
   */
  getAgentCard(): AgentCard {
    return generateAgentCard({
      agentId: this.agentId,
      name: this.agentName,
      publicKeyPem: this.signer.pubkeyPem(),
      minAcceptedRewardUsd: this.minAcceptedRewardUsd,
      acceptedCurrencies: ['USDT', 'USDC'],
      capabilities: [
        'financial-analysis',
        'smart-contract-audit',
        'data-synthesis',
        'cryptographic-signing',
      ],
      supportedTaskTypes: ['prompt-completion', 'structured-json-output'],
    });
  }
}
