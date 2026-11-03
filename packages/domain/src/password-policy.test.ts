import { describe, expect, it } from 'vitest';
import { checkPassword } from './password-policy';

const subject = { phoneE164: '+919876543210', fullName: 'Rahul Sharma', loginId: 'RA3210' };

describe('checkPassword (R-77: anything but empty)', () => {
  it.each(['1', 'rahul', '9876543210', 'RA3210', 'password123'])('accepts %s', (password) => {
    expect(checkPassword({ ...subject, password })).toEqual({ ok: true, reasons: [] });
  });

  it('refuses an empty password', () => {
    expect(checkPassword({ ...subject, password: '' }).reasons).toEqual(['TOO_SHORT']);
  });

  it('refuses one longer than the cap', () => {
    expect(checkPassword({ ...subject, password: 'a'.repeat(300) }).reasons).toEqual(['TOO_LONG']);
  });
});
