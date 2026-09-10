import { describe, expect, it } from 'vitest';
import {
  LOGIN_ID_MAX_ATTEMPTS,
  loginIdBase,
  loginIdCandidate,
  loginIdCandidates,
  loginIdPhoneSuffix,
  loginIdPrefix,
  normalizeNameForLoginId,
} from './login-id';

describe('normalizeNameForLoginId', () => {
  it('uppercases and drops non-alphabetic characters', () => {
    expect(normalizeNameForLoginId('Rahul Sharma')).toBe('RAHULSHARMA');
    expect(normalizeNameForLoginId("O'Neil")).toBe('ONEIL');
    expect(normalizeNameForLoginId('A. B.')).toBe('AB');
    expect(normalizeNameForLoginId('Jean-Luc  Picard')).toBe('JEANLUCPICARD');
  });

  it('strips diacritics rather than dropping the letters that carry them', () => {
    expect(normalizeNameForLoginId('Ramírez')).toBe('RAMIREZ');
    expect(normalizeNameForLoginId('Zoë Ångström')).toBe('ZOEANGSTROM');
    expect(normalizeNameForLoginId('Çetin Öztürk')).toBe('CETINOZTURK');
    expect(normalizeNameForLoginId('Renée')).toBe('RENEE');
  });

  it('returns an empty string when nothing alphabetic survives', () => {
    expect(normalizeNameForLoginId('123 456')).toBe('');
    expect(normalizeNameForLoginId('   ')).toBe('');
    expect(normalizeNameForLoginId('日本語')).toBe('');
  });
});

describe('loginIdPrefix', () => {
  it('takes the first two letters of the normalized name', () => {
    expect(loginIdPrefix('Rahul Sharma')).toBe('RA');
    expect(loginIdPrefix('A. B.')).toBe('AB');
    expect(loginIdPrefix("O'Neil")).toBe('ON');
  });

  it('pads names shorter than two letters with X', () => {
    expect(loginIdPrefix('Li')).toBe('LI');
    expect(loginIdPrefix('A')).toBe('AX');
    expect(loginIdPrefix('')).toBe('XX');
    expect(loginIdPrefix('123')).toBe('XX');
  });
});

describe('loginIdPhoneSuffix', () => {
  it('takes the last four digits regardless of formatting', () => {
    expect(loginIdPhoneSuffix('+919876543210')).toBe('3210');
    expect(loginIdPhoneSuffix('9876543210')).toBe('3210');
    expect(loginIdPhoneSuffix('+91 98765 43210')).toBe('3210');
    expect(loginIdPhoneSuffix('+91-98765-43210')).toBe('3210');
  });

  it('fails loudly when there are not four digits to take', () => {
    expect(() => loginIdPhoneSuffix('+91')).toThrow(/at least 4 digits/);
    expect(() => loginIdPhoneSuffix('abc')).toThrow(/at least 4 digits/);
  });
});

describe('loginIdBase', () => {
  it('produces the documented example', () => {
    expect(loginIdBase('Rahul Sharma', '+919876543210')).toBe('RA3210');
  });
});

describe('loginIdCandidate', () => {
  it('returns the bare base for the first attempt', () => {
    expect(loginIdCandidate('Rahul Sharma', '+919876543210', 0)).toBe('RA3210');
  });

  it('suffixes collisions from -2 upward, never -1', () => {
    expect(loginIdCandidate('Rahul Sharma', '+919876543210', 1)).toBe('RA3210-2');
    expect(loginIdCandidate('Rahul Sharma', '+919876543210', 2)).toBe('RA3210-3');
    expect(loginIdCandidate('Rahul Sharma', '+919876543210', 49)).toBe('RA3210-50');
  });

  it('rejects a negative or fractional attempt', () => {
    expect(() => loginIdCandidate('Rahul Sharma', '+919876543210', -1)).toThrow();
    expect(() => loginIdCandidate('Rahul Sharma', '+919876543210', 1.5)).toThrow();
  });

  it('collides for two different people sharing a prefix and phone suffix', () => {
    // This is the whole reason the collision loop exists: the generator is deterministic,
    // so distinct users legitimately produce the same base.
    const a = loginIdBase('Rahul Sharma', '+919876543210');
    const b = loginIdBase('Rajesh Singh', '+919812343210');
    expect(a).toBe(b);
    expect(loginIdCandidate('Rajesh Singh', '+919812343210', 1)).toBe('RA3210-2');
  });
});

describe('loginIdCandidates', () => {
  it('yields the bounded candidate sequence in order', () => {
    const candidates = [...loginIdCandidates('Rahul Sharma', '+919876543210', 3)];
    expect(candidates).toEqual(['RA3210', 'RA3210-2', 'RA3210-3']);
  });

  it('stops at the attempt ceiling rather than looping forever', () => {
    const candidates = [...loginIdCandidates('Rahul Sharma', '+919876543210')];
    expect(candidates).toHaveLength(LOGIN_ID_MAX_ATTEMPTS);
    expect(candidates.at(-1)).toBe(`RA3210-${LOGIN_ID_MAX_ATTEMPTS}`);
  });

  it('produces unique candidates', () => {
    const candidates = [...loginIdCandidates('Rahul Sharma', '+919876543210')];
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});
