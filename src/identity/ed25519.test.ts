import { describe, it, expect } from 'vitest';
import { canonicalJson, sha256Hex, sha256Hash } from './ed25519.js';

describe('Ed25519 and Canonical JSON', () => {
  it('canonicalJson sorts keys recursively', () => {
    const obj1 = { z: 1, a: 2, m: { y: 10, b: 20 } };
    const obj2 = { a: 2, m: { b: 20, y: 10 }, z: 1 };

    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
    expect(canonicalJson(obj1)).toBe('{"a":2,"m":{"b":20,"y":10},"z":1}');
  });

  it('sha256Hex produces deterministic hash', () => {
    const text = 'hello world';
    const hash = sha256Hex(text);
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('sha256Hash prefixes with sha256:', () => {
    const hash = sha256Hash('test');
    expect(hash.startsWith('sha256:')).toBe(true);
  });
});
