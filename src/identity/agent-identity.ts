/**
 * Zero-Trust Cryptographic Identity (Ed25519) for Autonomous Agents.
 *
 * Implements:
 *  - Keypair generation, PEM/hex serialization, and dynamic key rotation.
 *  - Automatic signing & verification of A2A requests (create_task, cancel, status).
 *  - Automatic signing & verification of response artifacts.
 *  - JWS-compliant signing of Agent Cards.
 *  - Strict zero-trust verification (clock skew check, replay prevention, expiration).
 */

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  canonicalJson,
  verifySignature,
  type Signer,
  createSignerFromKeyObjects,
} from './ed25519.js';
import type { Ed25519Sig } from '../core/types/index.js';
import type {
  A2ATaskExecutionRequest,
  A2ATaskExecutionResult,
} from '../core/types/a2a.types.js';

export interface AgentPassport {
  agentId: string;
  publicKeyPem: string;
  publicKeyHex: string;
  keyVersion: number;
  createdAt: string;
  expiresAt?: string;
}

export interface VerificationResult<T = unknown> {
  valid: boolean;
  data?: T;
  error?: string;
  signerAgentId?: string;
  keyVersion?: number;
}

export type A2AAction =
  | 'create_task'
  | 'cancel_task'
  | 'task_status'
  | 'artifact_delivery'
  | 'agent_card';

export interface A2AMessage<T = unknown> {
  action: A2AAction;
  payload: T;
  senderAgentId: string;
  recipientAgentId?: string;
  timestamp: string; // ISO 8601 UTC
  expiresAt?: string; // ISO 8601 UTC
  keyVersion: number;
  signerPubkey: string;
  signature: Ed25519Sig;
}

export interface SignedAgentCard {
  header: {
    alg: 'EdDSA';
    typ: 'JWT' | 'agent-card+json';
    kid: string;
  };
  payload: Record<string, unknown>;
  signature: Ed25519Sig;
  signerAgentId: string;
  signerPubkey: string;
  compactJws: string;
  timestamp: string;
}

export interface AgentIdentityOptions {
  keyPath?: string;
  initialKeyVersion?: number;
}

export class AgentIdentity {
  private currentSigner: Signer;
  private currentPrivateKey: KeyObject;
  private currentPublicKey: KeyObject;
  private version: number;
  private readonly historicalPublicKeys = new Map<number, string>();
  private readonly keyPath?: string;

  constructor(
    public readonly agentId: string,
    options?: AgentIdentityOptions,
  ) {
    this.version = options?.initialKeyVersion ?? 1;
    this.keyPath = options?.keyPath;

    if (this.keyPath && existsSync(this.keyPath)) {
      const pem = readFileSync(this.keyPath, 'utf8');
      this.currentPrivateKey = createPrivateKey(pem);
      this.currentPublicKey = createPublicKey(this.currentPrivateKey);
      this.currentSigner = createSignerFromKeyObjects(
        this.currentPrivateKey,
        this.currentPublicKey,
      );
    } else {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      this.currentPrivateKey = privateKey;
      this.currentPublicKey = publicKey;
      this.currentSigner = createSignerFromKeyObjects(privateKey, publicKey);

      if (this.keyPath) {
        mkdirSync(dirname(resolve(this.keyPath)), { recursive: true });
        const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
        writeFileSync(this.keyPath, pem, 'utf8');
        const pubPath = this.keyPath.replace(/\.key$/, '.pub');
        writeFileSync(pubPath, this.getPublicKeyPem(), 'utf8');
      }
    }

    this.historicalPublicKeys.set(this.version, this.getPublicKeyPem());
  }

  /** Static factory for creating an identity with generated or loaded keypair. */
  public static create(
    agentId: string,
    options?: AgentIdentityOptions,
  ): AgentIdentity {
    return new AgentIdentity(agentId, options);
  }

  /** Static factory for loading an identity from raw PEM string. */
  public static fromPem(
    agentId: string,
    pem: string,
    version = 1,
  ): AgentIdentity {
    const privKey = createPrivateKey(pem);
    const pubKey = createPublicKey(privKey);
    const identity = Object.create(AgentIdentity.prototype) as AgentIdentity;
    (identity as any).agentId = agentId;
    (identity as any).version = version;
    (identity as any).currentPrivateKey = privKey;
    (identity as any).currentPublicKey = pubKey;
    (identity as any).currentSigner = createSignerFromKeyObjects(privKey, pubKey);
    (identity as any).historicalPublicKeys = new Map<number, string>();
    (identity as any).historicalPublicKeys.set(version, pubKey.export({ type: 'spki', format: 'pem' }).toString());
    return identity;
  }

  public getSigner(): Signer {
    return this.currentSigner;
  }

  public getPublicKeyPem(): string {
    return this.currentSigner.pubkeyPem();
  }

  public getPublicKeyHex(): string {
    return (
      this.currentSigner.pubkeyHex?.() ??
      this.currentPublicKey.export({ type: 'spki', format: 'der' }).toString('hex')
    );
  }

  public getKeyVersion(): number {
    return this.version;
  }

  /** Returns verifiable public passport for this agent. */
  public getPassport(): AgentPassport {
    return {
      agentId: this.agentId,
      publicKeyPem: this.getPublicKeyPem(),
      publicKeyHex: this.getPublicKeyHex(),
      keyVersion: this.version,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Rotates the Ed25519 keypair, archiving the previous public key.
   * Increments keyVersion and writes to file if keyPath was provided.
   */
  public rotate(): AgentPassport {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    this.version += 1;
    this.currentPrivateKey = privateKey;
    this.currentPublicKey = publicKey;
    this.currentSigner = createSignerFromKeyObjects(privateKey, publicKey);
    this.historicalPublicKeys.set(this.version, this.getPublicKeyPem());

    if (this.keyPath) {
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
      writeFileSync(this.keyPath, pem, 'utf8');
      const pubPath = this.keyPath.replace(/\.key$/, '.pub');
      writeFileSync(pubPath, this.getPublicKeyPem(), 'utf8');
    }

    return this.getPassport();
  }

  /**
   * Signs a generic A2A message with action and payload.
   */
  public signMessage<T>(
    action: A2AAction,
    payload: T,
    options?: {
      recipientAgentId?: string;
      ttlMs?: number;
    },
  ): A2AMessage<T> {
    const now = Date.now();
    const ttlMs = options?.ttlMs ?? 60_000; // default 1 minute TTL
    const timestamp = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const signableBody = {
      action,
      payload,
      senderAgentId: this.agentId,
      recipientAgentId: options?.recipientAgentId,
      timestamp,
      expiresAt,
      keyVersion: this.version,
    };

    const canonical = canonicalJson(signableBody);
    const signature = this.currentSigner.sign(canonical);

    return {
      ...signableBody,
      signerPubkey: this.getPublicKeyPem(),
      signature,
    };
  }

  /**
   * Strict Zero-Trust verification of an A2A message.
   */
  public static verifyMessage<T>(
    message: A2AMessage<T>,
    options?: {
      expectedRecipientId?: string;
      maxAgeMs?: number;
      now?: number;
    },
  ): VerificationResult<T> {
    const now = options?.now ?? Date.now();

    // 1. Signature presence
    if (!message.signature || typeof message.signature !== 'string') {
      return { valid: false, error: 'Missing or malformed signature' };
    }

    if (!message.signerPubkey || typeof message.signerPubkey !== 'string') {
      return { valid: false, error: 'Missing signer public key' };
    }

    // 2. Recipient check
    if (
      options?.expectedRecipientId &&
      message.recipientAgentId &&
      message.recipientAgentId !== options.expectedRecipientId
    ) {
      return {
        valid: false,
        error: `Recipient mismatch: expected ${options.expectedRecipientId}, got ${message.recipientAgentId}`,
      };
    }

    // 3. Expiration check
    if (message.expiresAt) {
      const exp = Date.parse(message.expiresAt);
      if (Number.isNaN(exp) || now > exp) {
        return { valid: false, error: 'Message has expired' };
      }
    }

    // 4. Timestamp & Max Age check (clock skew allowance 60s)
    const msgTime = Date.parse(message.timestamp);
    if (Number.isNaN(msgTime)) {
      return { valid: false, error: 'Invalid message timestamp' };
    }
    if (msgTime > now + 60_000) {
      return { valid: false, error: 'Message timestamp is in the future' };
    }
    if (options?.maxAgeMs && now - msgTime > options.maxAgeMs) {
      return { valid: false, error: `Message exceeded max age of ${options.maxAgeMs}ms` };
    }

    // 5. Cryptographic signature check over canonical payload
    const signableBody = {
      action: message.action,
      payload: message.payload,
      senderAgentId: message.senderAgentId,
      recipientAgentId: message.recipientAgentId,
      timestamp: message.timestamp,
      expiresAt: message.expiresAt,
      keyVersion: message.keyVersion,
    };

    const canonical = canonicalJson(signableBody);
    const verified = verifySignature(canonical, message.signature, message.signerPubkey);
    if (!verified) {
      return { valid: false, error: 'Cryptographic signature verification failed' };
    }

    return {
      valid: true,
      data: message.payload,
      signerAgentId: message.senderAgentId,
      keyVersion: message.keyVersion,
    };
  }

  /**
   * Signs an A2ATaskExecutionRequest with Ed25519 passport.
   */
  public signA2ARequest(
    request: A2ATaskExecutionRequest,
    ttlMs = 60_000,
  ): A2ATaskExecutionRequest {
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();

    const signable = {
      taskId: request.taskId,
      toolId: request.toolId,
      parameters: request.parameters ?? {},
      costUsd: request.costUsd,
      clientAgentId: this.agentId,
      providerAgentId: request.providerAgentId,
      timeoutMs: request.timeoutMs ?? 30_000,
      timestamp,
      expiresAt,
    };

    const canonical = canonicalJson(signable);
    const signature = this.currentSigner.sign(canonical);

    return {
      ...request,
      clientAgentId: this.agentId,
      timestamp,
      expiresAt,
      signerPubkey: this.getPublicKeyPem(),
      signature,
    };
  }

  /**
   * Strictly verifies an A2ATaskExecutionRequest.
   */
  public static verifyA2ARequest(
    request: A2ATaskExecutionRequest,
    options?: {
      expectedProviderId?: string;
      maxAgeMs?: number;
      now?: number;
    },
  ): VerificationResult<A2ATaskExecutionRequest> {
    const now = options?.now ?? Date.now();

    if (!request.signature) {
      return { valid: false, error: 'A2A request missing signature' };
    }
    if (!request.signerPubkey) {
      return { valid: false, error: 'A2A request missing signerPubkey' };
    }

    if (
      options?.expectedProviderId &&
      request.providerAgentId !== options.expectedProviderId
    ) {
      return {
        valid: false,
        error: `Provider mismatch: expected ${options.expectedProviderId}, got ${request.providerAgentId}`,
      };
    }

    // Expiration check
    if (request.expiresAt) {
      const exp = Date.parse(request.expiresAt);
      if (Number.isNaN(exp) || now > exp) {
        return { valid: false, error: 'A2A request has expired' };
      }
    }

    // Timestamp freshness
    if (request.timestamp) {
      const t = Date.parse(request.timestamp);
      if (!Number.isNaN(t)) {
        if (t > now + 60_000) {
          return { valid: false, error: 'A2A request timestamp is in the future' };
        }
        if (options?.maxAgeMs && now - t > options.maxAgeMs) {
          return { valid: false, error: `A2A request exceeded max allowed age of ${options.maxAgeMs}ms` };
        }
      }
    }

    const signable = {
      taskId: request.taskId,
      toolId: request.toolId,
      parameters: request.parameters ?? {},
      costUsd: request.costUsd,
      clientAgentId: request.clientAgentId,
      providerAgentId: request.providerAgentId,
      timeoutMs: request.timeoutMs ?? 30_000,
      timestamp: request.timestamp,
      expiresAt: request.expiresAt,
    };

    const canonical = canonicalJson(signable);
    const verified = verifySignature(canonical, request.signature, request.signerPubkey);
    if (!verified) {
      return { valid: false, error: 'A2A request signature verification failed' };
    }

    return {
      valid: true,
      data: request,
      signerAgentId: request.clientAgentId,
    };
  }

  /**
   * Signs an A2ATaskExecutionResult output and metrics.
   */
  public signA2AResult(
    result: A2ATaskExecutionResult,
    taskId: string,
  ): A2ATaskExecutionResult {
    const timestamp = new Date().toISOString();
    const signable = {
      taskId,
      success: result.success,
      output: result.output,
      error: result.error,
      escrowStatus: result.escrowStatus,
      ratchetDecision: result.ratchetDecision,
      metrics: result.metrics,
      timestamp,
    };

    const canonical = canonicalJson(signable);
    const signature = this.currentSigner.sign(canonical);

    return {
      ...result,
      timestamp,
      signerPubkey: this.getPublicKeyPem(),
      signature,
    };
  }

  /**
   * Strictly verifies an A2ATaskExecutionResult artifact.
   */
  public static verifyA2AResult(
    result: A2ATaskExecutionResult,
    taskId: string,
    providerPubkey?: string,
  ): VerificationResult<A2ATaskExecutionResult> {
    if (!result.signature) {
      return { valid: false, error: 'A2A result missing signature' };
    }
    const pubkey = providerPubkey ?? result.signerPubkey;
    if (!pubkey) {
      return { valid: false, error: 'A2A result missing signerPubkey' };
    }

    const signable = {
      taskId,
      success: result.success,
      output: result.output,
      error: result.error,
      escrowStatus: result.escrowStatus,
      ratchetDecision: result.ratchetDecision,
      metrics: result.metrics,
      timestamp: result.timestamp,
    };

    const canonical = canonicalJson(signable);
    const verified = verifySignature(canonical, result.signature, pubkey);

    if (!verified) {
      return { valid: false, error: 'A2A result signature verification failed' };
    }

    return { valid: true, data: result };
  }

  /**
   * Signs an Agent Card with JWS-compliant header and compact representation.
   */
  public signAgentCard(
    card: Record<string, unknown>,
  ): SignedAgentCard {
    const timestamp = new Date().toISOString();
    const header = {
      alg: 'EdDSA' as const,
      typ: 'agent-card+json' as const,
      kid: `${this.agentId}#key-${this.version}`,
    };

    const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
    const b64Payload = Buffer.from(canonicalJson(card)).toString('base64url');
    const signingInput = `${b64Header}.${b64Payload}`;

    const signature = this.currentSigner.sign(signingInput);
    const sigHex = signature.startsWith('ed25519:')
      ? signature.slice(8)
      : signature;
    const b64Sig = Buffer.from(sigHex, 'hex').toString('base64url');
    const compactJws = `${signingInput}.${b64Sig}`;

    return {
      header,
      payload: card,
      signature,
      signerAgentId: this.agentId,
      signerPubkey: this.getPublicKeyPem(),
      compactJws,
      timestamp,
    };
  }

  /**
   * Verifies a SignedAgentCard or JWS compact string.
   */
  public static verifyAgentCard(
    signedCard: SignedAgentCard | string,
    signerPubkeyOverride?: string,
  ): VerificationResult<Record<string, unknown>> {
    try {
      let compactJws: string;
      let pubkey: string | undefined = signerPubkeyOverride;

      if (typeof signedCard === 'string') {
        compactJws = signedCard;
      } else {
        compactJws = signedCard.compactJws;
        pubkey = pubkey ?? signedCard.signerPubkey;
      }

      if (!pubkey) {
        return { valid: false, error: 'Signer public key is required to verify Agent Card' };
      }

      const parts = compactJws.split('.');
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        return { valid: false, error: 'Invalid JWS compact format: expected 3 dot-separated parts' };
      }

      const b64Header = parts[0];
      const b64Payload = parts[1];
      const b64Sig = parts[2];
      const signingInput = `${b64Header}.${b64Payload}`;
      const sigHex = Buffer.from(b64Sig, 'base64url').toString('hex');
      const signature: Ed25519Sig = `ed25519:${sigHex}` as Ed25519Sig;

      if (typeof signedCard !== 'string' && signedCard.signature && signedCard.signature !== signature) {
        return { valid: false, error: 'Agent Card signature field mismatch with compact JWS' };
      }

      const headerJson = Buffer.from(b64Header, 'base64url').toString('utf8');
      const header = JSON.parse(headerJson);
      if (header.alg !== 'EdDSA') {
        return { valid: false, error: `Unsupported JWS algorithm: ${header.alg}` };
      }

      const verified = verifySignature(signingInput, signature, pubkey);
      if (!verified) {
        return { valid: false, error: 'Agent Card cryptographic signature verification failed' };
      }

      const payloadJson = Buffer.from(b64Payload, 'base64url').toString('utf8');
      const card = JSON.parse(payloadJson) as Record<string, unknown>;

      return {
        valid: true,
        data: card,
      };
    } catch (err) {
      return { valid: false, error: `Agent Card parsing/verification error: ${String(err)}` };
    }
  }
}
