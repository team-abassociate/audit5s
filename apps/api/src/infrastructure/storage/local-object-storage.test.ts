import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalObjectStorage } from './local-object-storage';
import { MAX_GET_TTL_SECONDS, MAX_PUT_TTL_SECONDS, cappedTtl } from './object-storage';

/**
 * DECISIONS.md R-9, tested rather than asserted.
 *
 * The handoff's instruction about this driver was "do not let it become an untested
 * branch", and this file is the answer. The properties below are the ones the evidence
 * flow actually depends on — a URL that expires, a signature that covers the constrained
 * parameters, a key that cannot escape the storage root — and they are the properties
 * that make a filesystem stand-in a faithful one rather than a hole.
 */

let root: string;
let storage: LocalObjectStorage;

const BASE = 'http://127.0.0.1:3000/api/v1';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'audit5s-r9-'));
  storage = new LocalObjectStorage(root, {
    publicBaseUrl: BASE,
    // Fixed, so a signature is reproducible across the assertions below. The production
    // default is a fresh key per process.
    signingSecret: 'test-signing-secret-at-least-16',
  });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const KEY = 'evidence/unit-1/audit-1/zone-1/photo-1.jpg';

function queryOf(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf('?') + 1));
}

describe('the port’s TTL caps (§12.6)', () => {
  it('caps a GET at 300 s and a PUT at 900 s', () => {
    expect(MAX_GET_TTL_SECONDS).toBe(300);
    expect(MAX_PUT_TTL_SECONDS).toBe(900);
    expect(cappedTtl(86_400, MAX_GET_TTL_SECONDS)).toBe(300);
    expect(cappedTtl(60, MAX_GET_TTL_SECONDS)).toBe(60);
    // Never zero or negative: a URL that has already expired is a bug, not a policy.
    expect(cappedTtl(0, MAX_GET_TTL_SECONDS)).toBe(1);
    expect(cappedTtl(-10, MAX_PUT_TTL_SECONDS)).toBe(1);
  });

  it('refuses to mint a longer-lived URL than the port allows, however it is asked', async () => {
    const upload = await storage.presignPut(KEY, {
      expiresInSeconds: 86_400,
      contentType: 'image/jpeg',
      byteSize: 1024,
      checksumSha256: 'a'.repeat(64),
    });
    expect(upload.expiresIn).toBe(MAX_PUT_TTL_SECONDS);

    const download = await storage.presignGet(KEY, { expiresInSeconds: 86_400 });
    expect(download.expiresIn).toBe(MAX_GET_TTL_SECONDS);
  });
});

describe('presignPut', () => {
  it('mints an absolute URL on the signed storage route', async () => {
    const upload = await storage.presignPut(KEY, {
      expiresInSeconds: 900,
      contentType: 'image/jpeg',
      byteSize: 2048,
      checksumSha256: 'b'.repeat(64),
    });

    // The key travels base64url-encoded in one segment: a Fastify wildcard under a
    // controller prefix registers as a root-level `*` that matches everything.
    const encoded = LocalObjectStorage.encodeKey(KEY);
    expect(upload.url.startsWith(`${BASE}/${LocalObjectStorage.ROUTE_PREFIX}/${encoded}?`)).toBe(
      true,
    );
    expect(encoded).not.toContain('/');
    expect(LocalObjectStorage.decodeKey(encoded)).toBe(KEY);
    expect(upload.requiredHeaders['content-type']).toBe('image/jpeg');
  });

  it('verifies its own signature', async () => {
    const upload = await storage.presignPut(KEY, {
      expiresInSeconds: 900,
      contentType: 'image/png',
      byteSize: 4096,
      checksumSha256: 'c'.repeat(64),
    });

    const verdict = storage.verify('PUT', KEY, queryOf(upload.url));
    expect(verdict).toEqual({ ok: true, contentType: 'image/png', byteSize: 4096 });
  });

  it('refuses a signature minted for a different key', async () => {
    const upload = await storage.presignPut(KEY, {
      expiresInSeconds: 900,
      contentType: 'image/jpeg',
      byteSize: 2048,
      checksumSha256: 'd'.repeat(64),
    });

    // Object keys embed the Unit (§5.6), so a key swap is a cross-tenant write attempt.
    const elsewhere = 'evidence/unit-2/audit-9/zone-9/photo-1.jpg';
    expect(storage.verify('PUT', elsewhere, queryOf(upload.url))).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('refuses a signature minted for the other verb', async () => {
    const upload = await storage.presignPut(KEY, {
      expiresInSeconds: 900,
      contentType: 'image/jpeg',
      byteSize: 2048,
      checksumSha256: 'e'.repeat(64),
    });
    // An upload URL must not be usable as a read URL: the PUT window is 900 s and the
    // read window is 300 s precisely because they are different exposures.
    expect(storage.verify('GET', KEY, queryOf(upload.url))).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('refuses an edited content type or size, because the HMAC covers every parameter', async () => {
    const upload = await storage.presignPut(KEY, {
      expiresInSeconds: 900,
      contentType: 'image/jpeg',
      byteSize: 2048,
      checksumSha256: 'f'.repeat(64),
    });

    const tamperedType = queryOf(upload.url);
    tamperedType.set('ct', 'text/html');
    expect(storage.verify('PUT', KEY, tamperedType)).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });

    const tamperedSize = queryOf(upload.url);
    tamperedSize.set('sz', String(50 * 1024 * 1024));
    expect(storage.verify('PUT', KEY, tamperedSize)).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('refuses an extended expiry', async () => {
    const upload = await storage.presignPut(KEY, {
      expiresInSeconds: 900,
      contentType: 'image/jpeg',
      byteSize: 2048,
      checksumSha256: '1'.repeat(64),
    });

    const extended = queryOf(upload.url);
    extended.set('exp', String(Math.floor(Date.now() / 1000) + 86_400));
    expect(storage.verify('PUT', KEY, extended)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses an unsigned request outright', () => {
    expect(storage.verify('PUT', KEY, new URLSearchParams({ exp: '99999999999' }))).toEqual({
      ok: false,
      reason: 'MISSING_SIGNATURE',
    });
  });

  it('refuses a valid signature past its expiry', async () => {
    const upload = await storage.presignPut(KEY, {
      expiresInSeconds: 900,
      contentType: 'image/jpeg',
      byteSize: 2048,
      checksumSha256: '2'.repeat(64),
    });

    const later = Math.floor(Date.now() / 1000) + 901;
    expect(storage.verify('PUT', KEY, queryOf(upload.url), later)).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('refuses a signature from another instance’s key', async () => {
    const other = new LocalObjectStorage(root, {
      publicBaseUrl: BASE,
      signingSecret: 'a-completely-different-secret',
    });
    const upload = await other.presignPut(KEY, {
      expiresInSeconds: 900,
      contentType: 'image/jpeg',
      byteSize: 2048,
      checksumSha256: '3'.repeat(64),
    });

    expect(storage.verify('PUT', KEY, queryOf(upload.url))).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });
});

describe('presignGet', () => {
  it('mints a read URL that verifies as a GET and not as a PUT', async () => {
    const download = await storage.presignGet(KEY, { expiresInSeconds: 300 });
    expect(storage.verify('GET', KEY, queryOf(download.url)).ok).toBe(true);
    expect(storage.verify('PUT', KEY, queryOf(download.url)).ok).toBe(false);
  });
});

describe('storing and describing objects', () => {
  it('round-trips bytes and reports their size, checksum and type', async () => {
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
    const stored = await storage.put(KEY, body, 'image/jpeg');

    expect(stored.byteSize).toBe(body.byteLength);

    const head = await storage.head(KEY);
    expect(head).toMatchObject({
      key: KEY,
      byteSize: body.byteLength,
      contentType: 'image/jpeg',
      checksumSha256: stored.checksumSha256,
    });

    expect(await storage.get(KEY)).toEqual(body);
  });

  it('reads only the prefix a magic-byte sniff needs', async () => {
    const body = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(4096, 7),
    ]);
    await storage.put('evidence/unit-1/audit-1/zone-1/big.png', body, 'image/png');

    const header = await storage.readRange('evidence/unit-1/audit-1/zone-1/big.png', 12);
    expect(header).not.toBeNull();
    expect(header!.byteLength).toBe(12);
    expect([...header!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('reports a missing object as absent rather than throwing', async () => {
    // §9.4's "metadata without object": commit has to be able to say "not there yet".
    expect(await storage.head('evidence/unit-1/audit-1/zone-1/never-uploaded.jpg')).toBeNull();
    expect(await storage.readRange('evidence/unit-1/audit-1/zone-1/never-uploaded.jpg', 12)).toBeNull();
  });

  it('refuses a key that would escape the storage root', async () => {
    await expect(storage.put('../../etc/passwd', Buffer.from('x'), 'image/jpeg')).rejects.toThrow(
      /escapes the storage root/,
    );
  });
});

describe('what this driver does not claim', () => {
  it('says plainly that its presigned URLs do not leave the process (R-9)', () => {
    // The honest half of R-9. §5 wants media past the API; a filesystem cannot do that,
    // and the flag is how a deployment finds out from the startup log rather than from a
    // bandwidth graph.
    expect(storage.presignsOffProcess).toBe(false);
    expect(storage.describe().startsWith('file:')).toBe(true);
  });
});
