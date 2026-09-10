import { describe, expect, it } from 'vitest';
import * as argon2 from 'argon2';
import { ARGON2_OPTIONS, PASSWORD_ALGO, PasswordService } from './password.service';

/**
 * The Argon2 parameters are the security control, not a default nobody looked at
 * (ARCHITECTURE.md §12.1). Asserting them means lowering them to speed up a suite fails CI
 * rather than silently weakening every stored credential.
 */
describe('Argon2id parameters (§12.1)', () => {
  it('is argon2id at m=64MiB, t=3, p=1', () => {
    expect(ARGON2_OPTIONS.type).toBe(argon2.argon2id);
    expect(ARGON2_OPTIONS.memoryCost).toBe(65_536);
    expect(ARGON2_OPTIONS.timeCost).toBe(3);
    expect(ARGON2_OPTIONS.parallelism).toBe(1);
    expect(PASSWORD_ALGO).toBe('argon2id');
  });

  it('produces a hash that records those parameters', async () => {
    const service = new PasswordService();
    const hash = await service.hash('a-perfectly-fine-password');
    expect(hash.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);
  });

  it('salts, so the same password never hashes to the same value twice', async () => {
    const service = new PasswordService();
    const [a, b] = await Promise.all([service.hash('same-password'), service.hash('same-password')]);
    expect(a).not.toBe(b);
  });
});

describe('verification', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    const service = new PasswordService();
    const hash = await service.hash('the-right-password-1');
    expect(await service.verify(hash, 'the-right-password-1')).toBe(true);
    expect(await service.verify(hash, 'the-wrong-password-1')).toBe(false);
  });

  it('treats a malformed hash as a failure rather than throwing', async () => {
    // Throwing here would make the error itself an oracle: a caller could tell "no such
    // user" from "wrong password" by whether the request 500s.
    const service = new PasswordService();
    expect(await service.verify('not-a-hash', 'anything')).toBe(false);
    expect(await service.verify('', 'anything')).toBe(false);
  });

  it('reports that a weaker stored hash needs rehashing on login', async () => {
    const service = new PasswordService();
    const weak = await argon2.hash('legacy-password', {
      type: argon2.argon2id,
      memoryCost: 4096,
      timeCost: 2,
      parallelism: 1,
    });
    expect(service.needsRehash(weak)).toBe(true);
    expect(service.needsRehash(await service.hash('current-password'))).toBe(false);
  });
});

describe('policy enforcement', () => {
  const subject = {
    phoneE164: '+919876543210',
    fullName: 'Rahul Sharma',
    loginId: 'RA3210',
  };

  it('accepts a password unrelated to the user’s identifiers', () => {
    const service = new PasswordService();
    expect(() =>
      service.assertAcceptable({ ...subject, password: 'tumble-forge-42-KIT' }),
    ).not.toThrow();
  });

  it('rejects the bootstrap credential itself and names why', () => {
    const service = new PasswordService();
    try {
      service.assertAcceptable({ ...subject, password: '+919876543210' });
      throw new Error('should have thrown');
    } catch (error) {
      const problem = error as { code?: string; detail?: string };
      expect(problem.code).toBe('WEAK_PASSWORD');
      expect(problem.detail).toMatch(/phone number/i);
    }
  });
});
