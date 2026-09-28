/**
 * Peer Registry & Discovery for Autonomous Agents.
 *
 * Maintains a verified in-memory registry of peer agents, validates their
 * cryptographic Agent Card (JWS Ed25519) on discovery, and provides routing
 * resolution for outbound A2A task requests.
 */

import { AgentIdentity, type SignedAgentCard } from '../../identity/agent-identity.js';
import type { AgentCard, AgentSkill } from './agent-card.js';
import { createLogger } from '../../observability/logger.js';

export interface PeerRecord {
  agentId: string;
  name: string;
  version: string;
  description: string;
  publicKeyPem: string;
  publicKeyHex?: string;
  endpoints: {
    http: string;
    ws?: string;
    wellKnown?: string;
  };
  capabilities: string[];
  skills?: AgentSkill[];
  pricing: {
    minAcceptedRewardUsd: number;
    defaultCostUsd?: number;
    acceptedCurrencies: string[];
  };
  verifiedAt: string;
  signedCard: SignedAgentCard;
}

export class PeerRegistry {
  private readonly log = createLogger('peer-registry');
  private readonly peers = new Map<string, PeerRecord>();

  /**
   * Registers a peer by verifying its cryptographically signed Agent Card.
   * Throws or returns failure if signature verification fails.
   */
  public registerPeer(signedCard: SignedAgentCard): {
    success: boolean;
    peer?: PeerRecord;
    error?: string;
  } {
    const verification = AgentIdentity.verifyAgentCard(signedCard);
    if (!verification.valid || !verification.data) {
      this.log.warn(
        { agentId: signedCard.signerAgentId, error: verification.error },
        'rejecting peer registration: invalid Agent Card cryptographic signature',
      );
      return {
        success: false,
        error: `Agent Card signature verification failed: ${verification.error}`,
      };
    }

    const card = verification.data as unknown as AgentCard;
    const agentId = card.id || signedCard.signerAgentId;

    if (!card.endpoints?.http) {
      return {
        success: false,
        error: 'Agent Card must specify at least an HTTP endpoint',
      };
    }

    const record: PeerRecord = {
      agentId,
      name: card.name ?? agentId,
      version: card.version ?? '0.1.0',
      description: card.description ?? '',
      publicKeyPem: card.identity.publicKeyPem ?? signedCard.signerPubkey,
      publicKeyHex: card.identity.publicKeyHex,
      endpoints: card.endpoints,
      capabilities: card.capabilities ?? [],
      skills: card.skills ?? [],
      pricing: {
        minAcceptedRewardUsd: card.pricing?.minAcceptedRewardUsd ?? 0.05,
        defaultCostUsd: card.pricing?.defaultCostUsd ?? 0.05,
        acceptedCurrencies: card.pricing?.acceptedCurrencies ?? ['USD'],
      },
      verifiedAt: new Date().toISOString(),
      signedCard,
    };

    this.peers.set(agentId, record);
    this.log.info(
      { agentId, name: record.name, endpoint: record.endpoints.http },
      'registered peer agent into registry',
    );

    return { success: true, peer: record };
  }

  /**
   * Fetches and discovers a peer from its base URL, verifying its Agent Card.
   */
  public async discoverPeerFromUrl(baseUrl: string): Promise<{
    success: boolean;
    peer?: PeerRecord;
    error?: string;
  }> {
    const url = baseUrl.replace(/\/+$/, '') + '/.well-known/agent-card.json';
    try {
      this.log.info({ url }, 'discovering peer from URL');
      const res = await fetch(url, {
        headers: { Accept: 'application/json, text/plain' },
      });

      if (!res.ok) {
        return {
          success: false,
          error: `HTTP ${res.status} fetching agent card from ${url}`,
        };
      }

      const body = await res.json();
      return this.registerPeer(body as SignedAgentCard);
    } catch (err) {
      this.log.error({ err, url }, 'peer discovery failed');
      return {
        success: false,
        error: `Failed to discover peer from ${url}: ${String(err)}`,
      };
    }
  }

  public getPeer(agentId: string): PeerRecord | undefined {
    return this.peers.get(agentId);
  }

  public hasPeer(agentId: string): boolean {
    return this.peers.has(agentId);
  }

  public findPeersByCapability(capability: string): PeerRecord[] {
    const term = capability.toLowerCase();
    return Array.from(this.peers.values()).filter(
      (p) =>
        p.capabilities.some((c) => c.toLowerCase() === term) ||
        p.skills?.some((s) => s.id.toLowerCase() === term || s.name.toLowerCase().includes(term)),
    );
  }

  public findPeerForTool(toolId: string): PeerRecord | undefined {
    return Array.from(this.peers.values()).find(
      (p) =>
        p.skills?.some((s) => s.id === toolId) ||
        p.capabilities.includes(toolId) ||
        p.capabilities.includes('meta-tools'),
    );
  }

  public listPeers(): PeerRecord[] {
    return Array.from(this.peers.values());
  }

  public removePeer(agentId: string): boolean {
    return this.peers.delete(agentId);
  }

  public clear(): void {
    this.peers.clear();
  }
}
