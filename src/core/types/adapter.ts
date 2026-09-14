import type { Iso8601 } from './primitives.js';

/**
 * Where an adapter loads its credentials from.
 * Adapters are free to define their own inline shape when needed.
 */
export interface EnvCredentialSource {
  source: 'env';
  prefix: string;
}

export interface FileCredentialSource {
  source: 'file';
  path: string;
}

export type AdapterCredentials =
  | EnvCredentialSource
  | FileCredentialSource
  | Record<string, unknown>;

/** Static configuration loaded from `config/adapters/*.json`. */
export interface AdapterConfig {
  id: string;
  enabled: boolean;
  credentialsSource: 'env' | 'file' | 'inline';
  priority: number;
  credentials: AdapterCredentials;
}

export type AdapterStatus =
  | 'idle'
  | 'polling'
  | 'degraded'
  | 'stopped'
  | 'error';

/** Runtime health, published to observability. */
export interface AdapterHealth {
  id: string;
  status: AdapterStatus;
  lastPollAt?: Iso8601;
  lastErrorAt?: Iso8601;
  lastError?: string;
  tasksInFlight: number;
}