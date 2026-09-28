/**
 * Standardized A2A (Agent-to-Agent) Card Descriptor.
 *
 * Exposes machine-readable metadata, cryptographic identity (Ed25519),
 * operational capabilities, and economic policies for external marketplaces.
 */

import type { AgentIdentity as AgentIdentityClass, SignedAgentCard } from '../../identity/agent-identity.js';

export interface AgentCardIdentity {
  /** Cryptographic algorithm used for authentication and artifact verification. */
  type: 'ed25519';
  /** Algorithm specification name. */
  algorithm: 'Ed25519';
  /** SPKI PEM-formatted or Base64 Ed25519 public key. */
  publicKey: string;
  /** Full PEM-formatted public key for standardized cryptographic verification. */
  publicKeyPem?: string;
  /** Raw DER hex public key. */
  publicKeyHex?: string;
  /** Key version / generation identifier. */
  keyVersion?: number;
}

export interface AgentPricingPolicy {
  /** Minimum reward in USD/USDT required to consider accepting a task. */
  minAcceptedRewardUsd: number;
  /** Default estimated cost in USD. */
  defaultCostUsd?: number;
  /** Supported settlement tokens/currencies. */
  acceptedCurrencies: string[];
  /** Expected payment mechanisms (e.g. "escrow", "direct-transfer", "channel"). */
  paymentProtocols: string[];
}

export interface AgentEndpoints {
  http: string;
  ws?: string;
  wellKnown: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  version?: number;
  parametersSchema?: Record<string, unknown>;
}

export interface AgentPerformanceMetrics {
  uptimeSeconds: number;
  totalDeliveries: number;
  averageLatencyMs: number;
  reputationScore: number;
  system1HitRatio?: number;
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
  identity: AgentCardIdentity;
  /** Machine-readable capability tags (e.g. text-generation, code-analysis, summarization). */
  capabilities: string[];
  /** Supported task input formats. */
  supportedTaskTypes: string[];
  /** Registered meta-tools and skills. */
  skills?: AgentSkill[];
  /** Economic and pricing constraints for task triage. */
  pricing: AgentPricingPolicy;
  /** Network endpoints for M2M transport. */
  endpoints?: AgentEndpoints;
  /** Live performance and reputation telemetry. */
  performanceMetrics?: AgentPerformanceMetrics;
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
  publicKeyHex?: string;
  keyVersion?: number;
  minAcceptedRewardUsd?: number;
  defaultCostUsd?: number;
  acceptedCurrencies?: string[];
  capabilities?: string[];
  skills?: AgentSkill[];
  endpoints?: AgentEndpoints;
  performanceMetrics?: AgentPerformanceMetrics;
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
      publicKeyPem: options.publicKeyPem,
      publicKeyHex: options.publicKeyHex,
      keyVersion: options.keyVersion ?? 1,
    },
    capabilities: options.capabilities ?? [
      'text-generation',
      'code-synthesis',
      'data-analysis',
      'summarization',
      'cryptographic-signing',
      'system1-fast-path',
      'meta-tools',
    ],
    supportedTaskTypes: options.supportedTaskTypes ?? [
      'prompt-completion',
      'code-generation',
      'classification',
      'structured-json-output',
      'meta_tool',
      'a2a_service',
    ],
    skills: options.skills,
    pricing: {
      minAcceptedRewardUsd: options.minAcceptedRewardUsd ?? 0.05,
      defaultCostUsd: options.defaultCostUsd ?? 0.05,
      acceptedCurrencies: options.acceptedCurrencies ?? ['USD', 'USDT', 'USDC'],
      paymentProtocols: ['escrow', 'direct-transfer', 'web3-receipt'],
    },
    endpoints: options.endpoints ?? {
      http: 'http://localhost:3000/a2a',
      ws: 'ws://localhost:3000/a2a/ws',
      wellKnown: 'http://localhost:3000/.well-known/agent-card.json',
    },
    performanceMetrics: options.performanceMetrics ?? {
      uptimeSeconds: Math.floor(process.uptime()),
      totalDeliveries: 0,
      averageLatencyMs: 0,
      reputationScore: 1.0,
      system1HitRatio: 0.0,
    },
    runtime: {
      maxTimeoutSeconds: options.maxTimeoutSeconds ?? 120,
      preferredModel: options.preferredModel ?? 'gemini-1.5-flash',
    },
  };
}

/**
 * Builds and signs a complete JWS Agent Card using the agent's identity.
 */
export function generateSignedAgentCard(
  identity: AgentIdentityClass,
  options: Omit<CreateAgentCardOptions, 'agentId' | 'publicKeyPem' | 'publicKeyHex' | 'keyVersion'>,
): SignedAgentCard {
  const card = generateAgentCard({
    ...options,
    agentId: identity.agentId,
    publicKeyPem: identity.getPublicKeyPem(),
    publicKeyHex: identity.getPublicKeyHex(),
    keyVersion: identity.getKeyVersion(),
  });

  return identity.signAgentCard(card as unknown as Record<string, unknown>);
}
