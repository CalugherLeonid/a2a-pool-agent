import { describe, expect, it } from 'vitest';
import { AgentIdentity } from './agent-identity.js';
import type { A2ATaskExecutionRequest } from '../core/types/a2a.types.js';

describe('AgentIdentity: Zero-Trust Cryptographic Passports (Ed25519)', () => {
  it('generates a valid Ed25519 identity, keypair, and passport', () => {
    const identity = AgentIdentity.create('agent-alice');
    const passport = identity.getPassport();

    expect(passport.agentId).toBe('agent-alice');
    expect(passport.keyVersion).toBe(1);
    expect(passport.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(passport.publicKeyHex.length).toBeGreaterThan(32);
    expect(identity.getPublicKeyPem()).toBe(passport.publicKeyPem);
  });

  it('supports key rotation with incremented version and fresh keys', () => {
    const identity = AgentIdentity.create('agent-alice');
    const oldPem = identity.getPublicKeyPem();
    const oldVersion = identity.getKeyVersion();

    const newPassport = identity.rotate();

    expect(newPassport.keyVersion).toBe(oldVersion + 1);
    expect(newPassport.publicKeyPem).not.toBe(oldPem);
    expect(identity.getPublicKeyPem()).toBe(newPassport.publicKeyPem);
  });

  describe('A2A Message Envelopes', () => {
    it('signs and verifies a valid A2A message', () => {
      const alice = AgentIdentity.create('agent-alice');
      const bob = AgentIdentity.create('agent-bob');

      const message = alice.signMessage('create_task', { query: 'test query' }, {
        recipientAgentId: bob.agentId,
        ttlMs: 30_000,
      });

      const verification = AgentIdentity.verifyMessage(message, {
        expectedRecipientId: bob.agentId,
      });

      expect(verification.valid).toBe(true);
      expect(verification.signerAgentId).toBe('agent-alice');
      expect(verification.data).toEqual({ query: 'test query' });
    });

    it('rejects tampered message payload', () => {
      const alice = AgentIdentity.create('agent-alice');
      const message = alice.signMessage('create_task', { amount: 100 });

      // Attacker tampers with payload
      (message.payload as any).amount = 999999;

      const verification = AgentIdentity.verifyMessage(message);
      expect(verification.valid).toBe(false);
      expect(verification.error).toContain('signature verification failed');
    });

    it('rejects expired messages', () => {
      const alice = AgentIdentity.create('agent-alice');
      // Create message that expired 5 seconds ago
      const message = alice.signMessage('create_task', { task: 1 }, {
        ttlMs: -5_000,
      });

      const verification = AgentIdentity.verifyMessage(message);
      expect(verification.valid).toBe(false);
      expect(verification.error).toContain('Message has expired');
    });

    it('rejects messages with recipient mismatch', () => {
      const alice = AgentIdentity.create('agent-alice');
      const message = alice.signMessage('cancel_task', { taskId: 't-1' }, {
        recipientAgentId: 'agent-bob',
      });

      const verification = AgentIdentity.verifyMessage(message, {
        expectedRecipientId: 'agent-charlie',
      });

      expect(verification.valid).toBe(false);
      expect(verification.error).toContain('Recipient mismatch');
    });
  });

  describe('A2ATaskExecutionRequest Cryptographic Passports', () => {
    it('signs and verifies an A2A execution request', () => {
      const alice = AgentIdentity.create('agent-alice');
      const rawRequest: A2ATaskExecutionRequest = {
        taskId: 'task-101',
        toolId: 'summarize',
        parameters: { text: 'hello world' },
        costUsd: 0.05,
        clientAgentId: alice.agentId,
        providerAgentId: 'agent-bob',
        timeoutMs: 15_000,
      };

      const signedRequest = alice.signA2ARequest(rawRequest, 60_000);

      expect(signedRequest.signature).toBeDefined();
      expect(signedRequest.signature?.startsWith('ed25519:')).toBe(true);
      expect(signedRequest.signerPubkey).toBe(alice.getPublicKeyPem());
      expect(signedRequest.timestamp).toBeDefined();
      expect(signedRequest.expiresAt).toBeDefined();

      const verification = AgentIdentity.verifyA2ARequest(signedRequest, {
        expectedProviderId: 'agent-bob',
      });

      expect(verification.valid).toBe(true);
      expect(verification.signerAgentId).toBe('agent-alice');
    });

    it('rejects tampered A2A execution request cost or parameters', () => {
      const alice = AgentIdentity.create('agent-alice');
      const rawRequest: A2ATaskExecutionRequest = {
        taskId: 'task-102',
        toolId: 'scrape',
        parameters: { url: 'https://example.com' },
        costUsd: 10,
        clientAgentId: alice.agentId,
        providerAgentId: 'agent-bob',
      };

      const signedRequest = alice.signA2ARequest(rawRequest);

      // Malicious modification of costUsd
      signedRequest.costUsd = 0.0001;

      const verification = AgentIdentity.verifyA2ARequest(signedRequest);
      expect(verification.valid).toBe(false);
      expect(verification.error).toContain('signature verification failed');
    });

    it('rejects expired A2A execution requests', () => {
      const alice = AgentIdentity.create('agent-alice');
      const rawRequest: A2ATaskExecutionRequest = {
        taskId: 'task-103',
        toolId: 'scrape',
        costUsd: 1,
        clientAgentId: alice.agentId,
        providerAgentId: 'agent-bob',
      };

      // Expired TTL
      const signedRequest = alice.signA2ARequest(rawRequest, -10_000);

      const verification = AgentIdentity.verifyA2ARequest(signedRequest);
      expect(verification.valid).toBe(false);
      expect(verification.error).toContain('expired');
    });
  });

  describe('Agent Card JWS Signing and Verification', () => {
    it('signs an Agent Card into valid JWS and verifies it', () => {
      const alice = AgentIdentity.create('agent-alice');
      const card = {
        name: 'Alice Morphling Agent',
        description: 'Autonomous research and coding agent',
        capabilities: ['meta_tool', 'triage', 'code_synthesis'],
        protocols: ['a2a/v1', 'http-jsonrpc'],
        pricing: { defaultCostUsd: 0.05 },
      };

      const signedCard = alice.signAgentCard(card);

      expect(signedCard.header.alg).toBe('EdDSA');
      expect(signedCard.signature.startsWith('ed25519:')).toBe(true);
      expect(signedCard.compactJws.split('.').length).toBe(3);

      const verification = AgentIdentity.verifyAgentCard(signedCard);
      expect(verification.valid).toBe(true);
      expect(verification.data).toEqual(card);
    });

    it('verifies compact JWS string directly with signer public key', () => {
      const alice = AgentIdentity.create('agent-alice');
      const card = { service: 'calculator', version: '2.0.0' };
      const signedCard = alice.signAgentCard(card);

      const verification = AgentIdentity.verifyAgentCard(
        signedCard.compactJws,
        alice.getPublicKeyPem(),
      );

      expect(verification.valid).toBe(true);
      expect(verification.data).toEqual(card);
    });

    it('rejects tampered Agent Card JWS payload', () => {
      const alice = AgentIdentity.create('agent-alice');
      const card = { price: 10 };
      const signedCard = alice.signAgentCard(card);

      // Tamper with middle part (payload)
      const parts = signedCard.compactJws.split('.');
      const tamperedPayload = Buffer.from(JSON.stringify({ price: 0 })).toString('base64url');
      const tamperedJws = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const verification = AgentIdentity.verifyAgentCard(
        tamperedJws,
        alice.getPublicKeyPem(),
      );

      expect(verification.valid).toBe(false);
      expect(verification.error).toContain('signature verification failed');
    });
  });
});
