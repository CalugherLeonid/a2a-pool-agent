import type { Ed25519Sig, Iso8601, Usd, Uuid } from './primitives.js';

export interface Erc8004Identity {
  chain: 'bsc-testnet' | 'bsc' | 'xlayer';
  contractAddress: string;
  tokenId: string;
}

/**
 * The agent's stable, portable identity. Wallets live separately and are
 * per-platform.
 */
export interface AgentIdentity {
  agentId: Uuid;
  name: string;
  createdAt: Iso8601;
  ed25519Pubkey: string;
  erc8004Identity?: Erc8004Identity;
  solanaPubkey?: string;
}

/** A signed passport attached to a delivery. */
export interface Passport {
  agentId: Uuid;
  taskId: string;
  outputHash: string;
  signature: Ed25519Sig;
  issuedAt: Iso8601;
}

/** A snapshot of reputation for a given adapter (or "global"). */
export interface ReputationSnapshot {
  adapterId: string | 'global';
  successRate: number;
  averageQuality: number;
  totalTasks: number;
  totalProfitUsd: Usd;
  windowDays: number;
  asOf: Iso8601;
}