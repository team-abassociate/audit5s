import { describe, expect, it } from 'vitest';
import { proposedRefreshTokenSchema } from '@audit5s/contracts';
import { proposeRefreshToken } from './refresh-token';

describe('proposeRefreshToken', () => {
  it('encodes exactly as Node base64url does', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255);
    expect(proposeRefreshToken(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });

  it('is a shape the server accepts', () => {
    expect(proposedRefreshTokenSchema.safeParse(proposeRefreshToken()).success).toBe(true);
  });

  it('differs every time', () => {
    expect(proposeRefreshToken()).not.toBe(proposeRefreshToken());
  });
});
