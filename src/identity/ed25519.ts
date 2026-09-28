/**
 * Ed25519 signing and canonical JSON helpers.
 *
 * Every delivery is signed with the agent's Ed25519 key. The hash is
 * taken over the canonical (deterministic, key-sorted) JSON of the
 * output. The signature is over the SHA-256 hash.
 *
 * Format conventions:
 *   - hash: `sha256:<hex>`
 *   - signature: `ed25519:<hex>`
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Ed25519Sig, Sha256Hash } from '../core/types/index.js';

export interface Signer {
  /** Sign a message string; returns a prefixed Ed25519 signature. */
  sign(message: string): Ed25519Sig;
  /** PEM-encoded public key. */
  pubkeyPem(): string;
  /** Raw hex-encoded public key (DER SPKI or raw key buffer). */
  pubkeyHex?(): string;
}

/** Creates a Signer from private and public KeyObjects. */
export function createSignerFromKeyObjects(
  privateKey: KeyObject,
  publicKey: KeyObject,
): Signer {
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    sign(message: string): Ed25519Sig {
      const hash = createHash('sha256').update(message).digest();
      const sig = cryptoSign(null, hash, privateKey);
      return ('ed25519:' + sig.toString('hex')) as Ed25519Sig;
    },
    pubkeyPem(): string {
      return pubPem;
    },
    pubkeyHex(): string {
      return pubDer.toString('hex');
    },
  };
}

/** Generates a fresh in-memory Ed25519 keypair and returns a Signer. */
export function generateSigner(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return createSignerFromKeyObjects(privateKey, publicKey);
}

/** Verifies an Ed25519 signature against a message string and PEM-encoded public key. */
export function verifySignature(
  message: string,
  signature: string,
  pubkeyPemOrDerHex: string,
): boolean {
  try {
    const hash = createHash('sha256').update(message).digest();
    const sigHex = signature.startsWith('ed25519:')
      ? signature.slice(8)
      : signature;
    const sigBuffer = Buffer.from(sigHex, 'hex');

    let publicKey: KeyObject;
    if (pubkeyPemOrDerHex.includes('BEGIN PUBLIC KEY')) {
      publicKey = createPublicKey(pubkeyPemOrDerHex);
    } else {
      // Treat as DER hex
      publicKey = createPublicKey({
        key: Buffer.from(pubkeyPemOrDerHex, 'hex'),
        format: 'der',
        type: 'spki',
      });
    }

    return cryptoVerify(null, hash, publicKey, sigBuffer);
  } catch {
    return false;
  }
}

/** Load an Ed25519 private key from a PKCS#8 PEM file, or generate one if missing. */
export function loadSignerFromPemPath(path: string): Signer {
  let pem: string;
  if (!existsSync(path)) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    writeFileSync(path, pem, { encoding: 'utf8' });
    const pubPath = path.replace(/\.key$/, '.pub');
    writeFileSync(pubPath, pubPem, { encoding: 'utf8' });
  } else {
    pem = readFileSync(path, 'utf8');
  }

  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);

  return {
    sign(message: string): Ed25519Sig {
      const hash = createHash('sha256').update(message).digest();
      const sig = cryptoSign(null, hash, privateKey);
      return ('ed25519:' + sig.toString('hex')) as Ed25519Sig;
    },
    pubkeyPem(): string {
      return publicKey.export({ type: 'spki', format: 'pem' }).toString();
    },
  };
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(message: string): string {
  return createHash('sha256').update(message).digest('hex');
}

/** SHA-256 hash in prefixed form. */
export function sha256Hash(message: string): Sha256Hash {
  return ('sha256:' + sha256Hex(message)) as Sha256Hash;
}
