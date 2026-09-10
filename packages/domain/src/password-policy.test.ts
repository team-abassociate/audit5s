import { describe, expect, it } from 'vitest';
import { checkPassword } from './password-policy';

const subject = {
  phoneE164: '+919876543210',
  fullName: 'Rahul Sharma',
  loginId: 'RA3210',
};

describe('checkPassword', () => {
  it('accepts a password that shares nothing with the user’s own identifiers', () => {
    expect(checkPassword({ ...subject, password: 'tumble-forge-42-KIT' })).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it('enforces the 10-character minimum (§12.1)', () => {
    const result = checkPassword({ ...subject, password: 'short1!' });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('TOO_SHORT');
  });

  it('rejects the bootstrap credential itself — the phone number (CH-1)', () => {
    const result = checkPassword({ ...subject, password: '9876543210' });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('CONTAINS_PHONE');
  });

  it('rejects a password that merely pads the phone number', () => {
    const result = checkPassword({ ...subject, password: 'abc9876543210xyz' });
    expect(result.reasons).toContain('CONTAINS_PHONE');
  });

  it('rejects a password containing the user’s own name, punctuation notwithstanding', () => {
    expect(checkPassword({ ...subject, password: 'rahulsharma99' }).reasons).toContain(
      'CONTAINS_NAME',
    );
    expect(checkPassword({ ...subject, password: 'Rahul.Sharma.1' }).reasons).toContain(
      'CONTAINS_NAME',
    );
  });

  it('rejects a password containing the login ID', () => {
    expect(checkPassword({ ...subject, password: 'ra3210-secure!' }).reasons).toContain(
      'CONTAINS_LOGIN_ID',
    );
  });

  it('rejects obviously common passwords without needing the breach list', () => {
    expect(checkPassword({ ...subject, password: 'password123' }).reasons).toContain('COMMON');
  });

  it('consults the injected breach predicate', () => {
    const result = checkPassword({ ...subject, password: 'correct-horse-battery' }, (pw) =>
      pw.startsWith('correct-horse'),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('BREACHED');
  });

  it('reports every reason at once rather than stopping at the first', () => {
    const result = checkPassword({ ...subject, password: 'rahul' });
    expect(result.reasons).toContain('TOO_SHORT');
    expect(result.reasons).toContain('CONTAINS_NAME');
  });

  it('rejects an over-long password', () => {
    const result = checkPassword({ ...subject, password: 'a'.repeat(300) });
    expect(result.reasons).toContain('TOO_LONG');
  });
});
