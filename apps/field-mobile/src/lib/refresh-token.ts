const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A refresh token the phone proposes as its own successor: 32 random bytes, base64url, the
 * shape the server issues. It is saved before the refresh request leaves, so a reply lost
 * to a dead zone does not lose the session with it (`refreshRequestSchema`).
 */
export function proposeRefreshToken(bytes: Uint8Array = randomBytes(32)): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET[(buffer >> bits) & 63];
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (6 - bits)) & 63];
  return out;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
