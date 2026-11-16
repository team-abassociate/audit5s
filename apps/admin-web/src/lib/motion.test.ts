/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bezier, seconds } from './motion';

describe('seconds', () => {
  it('reads ms and s, and anything else is instant', () => {
    expect(seconds('120ms')).toBe(0.12);
    expect(seconds('0.22s')).toBe(0.22);
    expect(seconds('')).toBe(0);
    expect(seconds('fast')).toBe(0);
  });
});

describe('bezier', () => {
  it('reads a cubic-bezier and rejects anything else', () => {
    expect(bezier('cubic-bezier(.23,1,.32,1)')).toEqual([0.23, 1, 0.32, 1]);
    expect(bezier('ease-out')).toBeUndefined();
    expect(bezier('cubic-bezier(1,2)')).toBeUndefined();
  });
});

describe('ledger-tokens.css', () => {
  // Read from disk: Vitest replaces CSS imports, even ?raw ones, with an empty string.
  const tokens = readFileSync(new URL('../../../../docs/design/ledger-tokens.css', import.meta.url), 'utf8');
  // A renamed token would make Motion silently instant; fail here instead.
  const token = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1] ?? '';
  it('still defines the timings Motion reads', () => {
    expect(seconds(token('--dur-micro'))).toBeGreaterThan(0);
    expect(seconds(token('--dur-short'))).toBeGreaterThan(0);
    expect(bezier(token('--ease-out'))).toBeDefined();
  });
});
