/**
 * Standardized A2A (Agent-to-Agent) Card Descriptor.
 *
 * Exposes machine-readable metadata, cryptographic identity (Ed25519),
 * operational capabilities, and economic policies for external marketplaces.
 */

export interface AgentIdentity {
  /** Cryptographic algorithm used for authentication and artifact verification. */
  type: 'ed25519';
  /** Algorithm specification name. */
  algorithm: 'Ed25519';
  /** SPKI PEM-formatted or Base64 Ed25519 public key. */
  publicKey: string;
}

export interface AgentPricingPolicy {
  /** Minimum reward in USD/USDT required to consider accepting a task. */
  minAcceptedRewardUsd: number;
  /** Supported settlement tokens/currencies. */
  acceptedCurrencies: string[];
  /** Expected payment mechanisms (e.g. "escrow", "direct-transfer", "channel"). */
  paymentProtocols: string[];
}

export interface AgentCard {
  /** Protocol schema version (A2A v1). */
  schemaVersion: '1.0.0';
  /** Global identifier of the autonomous agent. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Semantic version of agent build. */
  version: string;
  /** Functional description of autonomous capabilities. */
  description: string;
  /** Cryptographic verification card. */
  identity: AgentIdentity;
  /** Machine-readable capability tags (e.g. text-generation, code-analysis, summarization). */
  capabilities: string[];
  /** Supported task input formats. */
  supportedTaskTypes: string[];
  /** Economic and pricing constraints for task triage. */
  pricing: AgentPricingPolicy;
  /** Operational parameters. */
  runtime: {
    maxTimeoutSeconds: number;
    preferredModel?: string;
  };
}

export interface CreateAgentCardOptions {
  agentId: string;
  name: string;
  version?: string;
  description?: string;
  publicKeyPem: string;
  minAcceptedRewardUsd?: number;
  acceptedCurrencies?: string[];
  capabilities?: string[];
  supportedTaskTypes?: string[];
  maxTimeoutSeconds?: number;
  preferredModel?: string;
}

/**
 * Generates a standardized, deterministic A2A Agent Card.
 */
export function generateAgentCard(options: CreateAgentCardOptions): AgentCard {
  // Normalize public key to single-line Base64 or clean PEM string
  const cleanPubKey = options.publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');

  return {
    schemaVersion: '1.0.0',
    id: options.agentId,
    name: options.name,
    version: options.version ?? '0.1.0',
    description:
      options.description ??
      'Autonomous multi-marketplace A2A pool agent with economic triage and Ed25519 verification.',
    identity: {
      type: 'ed25519',
      algorithm: 'Ed25519',
      publicKey: cleanPubKey,
    },
    capabilities: options.capabilities ?? [
      'text-generation',
      'code-synthesis',
      'data-analysis',
      'summarization',
      'cryptographic-signing',
    ],
    supportedTaskTypes: options.supportedTaskTypes ?? [
      'prompt-completion',
      'code-generation',
      'classification',
      'structured-json-output',
    ],
    pricing: {
      minAcceptedRewardUsd: options.minAcceptedRewardUsd ?? 0.05,
      acceptedCurrencies: options.acceptedCurrencies ?? ['USD', 'USDT', 'USDC'],
      paymentProtocols: ['escrow', 'direct-transfer', 'web3-receipt'],
    },
    runtime: {
      maxTimeoutSeconds: options.maxTimeoutSeconds ?? 120,
      preferredModel: options.preferredModel ?? 'gemini-1.5-flash',
    },
  };
}
