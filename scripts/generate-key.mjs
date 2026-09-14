#!/usr/bin/env node
/**
 * Generates an Ed25519 keypair for signing deliveries.
 *
 * Usage:
 *   node scripts/generate-key.mjs               # default: keys/agent.key
 *   node scripts/generate-key.mjs keys/foo.key  # custom path
 *
 * The private key is written as PKCS#8 PEM, the public key as SPKI PEM.
 * If the private key already exists, the script refuses to overwrite.
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const keyPath = process.argv[2] ?? 'keys/agent.key';
const pubPath = keyPath.replace(/\.key$/, '.pub');

if (existsSync(keyPath)) {
  console.error('Key already exists at ' + keyPath);
  console.error(
    'Delete it manually if you want to regenerate (this breaks existing passports).',
  );
  process.exit(1);
}

mkdirSync(dirname(resolve(keyPath)), { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

writeFileSync(
  keyPath,
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
  { encoding: 'utf8' },
);
writeFileSync(
  pubPath,
  publicKey.export({ type: 'spki', format: 'pem' }),
  { encoding: 'utf8' },
);

console.log('Generated Ed25519 keypair:');
console.log('  private: ' + keyPath);
console.log('  public:  ' + pubPath);
console.log('');
console.log('The private key is gitignored via the keys/ rule.');
