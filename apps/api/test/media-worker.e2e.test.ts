import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH, type Audit, type Evidence } from '@audit5s/contracts';
import { readImageDimensions, stripImageMetadata, thumbnailObjectKey } from '@audit5s/domain';
import { MediaWorker } from '../src/modules/evidence/media.worker';
import { ObjectStorage } from '../src/infrastructure/storage/object-storage';
import { QueueService } from '../src/infrastructure/queue/queue.service';
import { captureEvidence, loginFromDevice, startWorld, stopWorld, type TestWorld } from './harness';

/**
 * The media worker (§5.4's `EVIDENCE_ATTACHED` consumer, §12.8), against the real
 * application, the real storage driver and real image bytes.
 *
 * The worker is invoked directly rather than through pg-boss. What pg-boss guarantees —
 * that the job exists if and only if the commit committed — is R-2's, asserted by
 * `queue-rollback.e2e.test.ts` for the mechanism and by the enqueue assertion below for
 * this queue. What is under test here is the handler: what it does to the bytes, what it
 * records, and what it refuses.
 */

let world: TestWorld;
let worker: MediaWorker;
let storage: ObjectStorage;
const base = API_BASE_PATH;

const DEVICE_ID = '01930000-0000-7000-8000-0000000ac001';
let consultantToken: string;

beforeAll(async () => {
  world = await startWorld();
  consultantToken = await loginFromDevice(world, world.actors.CONSULTANT, DEVICE_ID);
  worker = world.app.get(MediaWorker);
  storage = world.app.get(ObjectStorage);
}, 180_000);

afterAll(async () => {
  await stopWorld(world);
});

// ------------------------------------------------------------------------------ fixtures

const ASCII = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

/** An EXIF `APP1` carrying a GPS tag and an orientation — what §12.8 is about. */
const EXIF_WITH_GPS = [
  ...ASCII('Exif'),
  0x00, 0x00,
  0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
  0x00, 0x02,
  // GPSInfo (0x8825), LONG, 1
  0x88, 0x25, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  // Orientation (0x0112), SHORT, 1, value 6
  0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
];

/**
 * A real, decodable JPEG of the given size, optionally carrying EXIF.
 *
 * Encoded with the same library the worker decodes with, so the thumbnail assertions are
 * about real pixels rather than a hand-built header. The EXIF is then spliced in after
 * the `SOI`, which is exactly where a camera would put it.
 */
async function jpegOf(
  width: number,
  height: number,
  options: { exif?: boolean } = {},
): Promise<Buffer> {
  const { Jimp } = await import('jimp');
  const image = new Jimp({ width, height, color: 0x3366ccff });
  const encoded = Buffer.from(await image.getBuffer('image/jpeg', { quality: 80 }));

  if (!options.exif) return encoded;

  return Buffer.concat([
    encoded.subarray(0, 2),
    Buffer.from(segment(0xe1, EXIF_WITH_GPS)),
    Buffer.from(segment(0xfe, ASCII('Shot on a modified build'))),
    encoded.subarray(2),
  ]);
}

let zoneCounter = 80;

/** A started walk-by with one Zone. A walk-by needs no checklist, so this is the cheapest. */
async function walkByZone(): Promise<{ auditId: string; auditZoneId: string }> {
  zoneCounter += 1;
  const { rows } = await world.owner.query(
    `INSERT INTO zone (unit_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [world.unitA, `Z-${zoneCounter}`, `Media zone ${zoneCounter}`],
  );

  const auditId = randomUUID();
  const created = await world.request('POST', `${base}/audits`, {
    token: consultantToken,
    body: { id: auditId, auditType: 'WALK_BY', unitId: world.unitA, deviceId: DEVICE_ID },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  await captureEvidence(world, {
    token: consultantToken,
    evidenceId: randomUUID(),
    auditId,
    kind: 'AUDITOR_SELFIE',
    deviceId: DEVICE_ID,
  });
  await world.request('POST', `${base}/audits/${auditId}/start`, {
    token: consultantToken,
    body: { deviceId: DEVICE_ID },
  });

  const auditZoneId = randomUUID();
  const zone = await world.request('PUT', `${base}/audits/${auditId}/zones/${auditZoneId}`, {
    token: consultantToken,
    body: { zoneId: rows[0].id, sequenceNo: 1 },
  });
  expect(zone.status, JSON.stringify(zone.body)).toBe(200);

  return { auditId, auditZoneId };
}

/** A photograph pushed through the real three-step protocol, with the given bytes. */
async function capture(
  auditId: string,
  auditZoneId: string,
  bytes: Buffer,
): Promise<{ evidenceId: string; objectKey: string }> {
  const evidenceId = randomUUID();
  const { objectKey } = await captureEvidence(world, {
    token: consultantToken,
    evidenceId,
    auditId,
    auditZoneId,
    kind: 'WALK_BY_PHOTO',
    classification: 'NONCONFORMITY',
    deviceId: DEVICE_ID,
    bytes,
  });
  return { evidenceId, objectKey };
}

function run(evidenceId: string): Promise<void> {
  return worker.handle({ evidenceId, auditorUserId: world.actors.CONSULTANT.userId });
}

async function rowOf(evidenceId: string) {
  const { rows } = await world.owner.query(
    `SELECT thumbnail_object_key, stored_checksum_sha256, checksum_sha256,
            media_processed_at, byte_size
       FROM evidence WHERE id = $1`,
    [evidenceId],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------------------

describe('R-2 — the job is enqueued inside the commit', () => {
  it('queues exactly one media job when a photograph commits', async () => {
    // Not "a job appears eventually": the enqueue is on the commit's own transaction, so
    // by the time the commit has returned 200 the job row is already there.
    const { auditId, auditZoneId } = await walkByZone();
    const { evidenceId } = await capture(auditId, auditZoneId, await jpegOf(64, 48));

    const { rows } = await world.owner.query(
      `SELECT COUNT(*)::int AS count FROM pgboss.job
        WHERE name = 'media.process' AND data->>'evidenceId' = $1`,
      [evidenceId],
    );
    expect(rows[0].count).toBe(1);
  });

  it('carries the auditor’s identity, not their authority', async () => {
    const { auditId, auditZoneId } = await walkByZone();
    const { evidenceId } = await capture(auditId, auditZoneId, await jpegOf(64, 48));

    const { rows } = await world.owner.query(
      `SELECT data FROM pgboss.job
        WHERE name = 'media.process' AND data->>'evidenceId' = $1`,
      [evidenceId],
    );
    // A user id and nothing else: no role, no resolver, no grant. The worker re-reads all
    // three, so an account disabled in between cannot have work done under yesterday's
    // standing.
    expect(Object.keys(rows[0].data as object).sort()).toEqual(['auditorUserId', 'evidenceId']);
    expect((rows[0].data as { auditorUserId: string }).auditorUserId).toBe(
      world.actors.CONSULTANT.userId,
    );
  });
});

describe('thumbnails (PART 16)', () => {
  it('writes a ≤320 px JPEG beside the original and records its key', async () => {
    const { auditId, auditZoneId } = await walkByZone();
    const { evidenceId, objectKey } = await capture(
      auditId,
      auditZoneId,
      await jpegOf(1920, 1080),
    );

    expect((await rowOf(evidenceId)).thumbnail_object_key).toBeNull();

    await run(evidenceId);

    const row = await rowOf(evidenceId);
    // The key is derived, not invented: a suffix, so §5.6's per-Unit prefix still reaches
    // the thumbnail.
    expect(row.thumbnail_object_key).toBe(thumbnailObjectKey(objectKey));
    expect(String(row.thumbnail_object_key).startsWith(`evidence/${world.unitA}/`)).toBe(true);
    expect(row.media_processed_at).not.toBeNull();

    // And it is a real image, of the right size, actually in storage.
    const thumbnail = await storage.get(row.thumbnail_object_key as string);
    expect(readImageDimensions(thumbnail)).toEqual({ width: 320, height: 180 });
    // Smaller than the original by an order of magnitude — which is the entire point of
    // "originals fetched only on demand".
    expect(thumbnail.byteLength).toBeLessThan((await storage.get(objectKey)).byteLength / 4);
  });

  it('is idempotent, because pg-boss may deliver a job twice', async () => {
    const { auditId, auditZoneId } = await walkByZone();
    const { evidenceId } = await capture(auditId, auditZoneId, await jpegOf(800, 600));

    await run(evidenceId);
    const first = await rowOf(evidenceId);

    await run(evidenceId);
    const second = await rowOf(evidenceId);

    // The second delivery does no work at all: same key, same timestamp, and — the one
    // that matters, because this worker rewrites objects — the same stored checksum.
    expect(second).toEqual(first);
  });

  it('skips a deleted photograph and a redacted one', async () => {
    const { auditId, auditZoneId } = await walkByZone();

    const deleted = await capture(auditId, auditZoneId, await jpegOf(400, 300));
    // Keep one live photograph so E-4's delete is the only thing under test here.
    await capture(auditId, auditZoneId, await jpegOf(400, 300));
    await world.request('DELETE', `${base}/evidence/${deleted.evidenceId}`, {
      token: consultantToken,
    });

    await run(deleted.evidenceId);
    expect((await rowOf(deleted.evidenceId)).media_processed_at).toBeNull();

    // R-5: the object behind a redacted row is a placeholder. Thumbnailing it would make a
    // small picture of "photo removed"; stripping it would rewrite what the redaction put
    // there.
    const redacted = await capture(auditId, auditZoneId, await jpegOf(400, 300));
    await world.owner.query(
      `UPDATE evidence SET redacted_at = now(), redacted_by_user_id = $2,
                           redaction_reason = 'Data-subject request'
        WHERE id = $1`,
      [redacted.evidenceId, world.actors.SUPER_ADMIN.userId],
    );

    await run(redacted.evidenceId);
    expect((await rowOf(redacted.evidenceId)).media_processed_at).toBeNull();
  });

  it('refuses to decode a header that declares more pixels than the cap (§12.8)', async () => {
    // The decompression-bomb control. A small file that *claims* 30000 × 30000 is refused
    // on its header, before a bitmap is allocated — and the row is still marked processed,
    // because the worker has finished with it and retrying would allocate nothing new.
    const { auditId, auditZoneId } = await walkByZone();
    const real = await jpegOf(64, 48);

    // Splice in a frame header claiming a bomb, ahead of the real one. `readImageDimensions`
    // reads the first `SOFn` it finds, which is what a decoder would size its buffer from.
    const bomb = Buffer.concat([
      real.subarray(0, 2),
      Buffer.from(
        segment(0xc0, [0x08, 0x75, 0x30, 0x75, 0x30, 0x01, 0x01, 0x11, 0x00]),
      ),
      real.subarray(2),
    ]);
    expect(readImageDimensions(bomb)).toEqual({ width: 30_000, height: 30_000 });

    const { evidenceId } = await capture(auditId, auditZoneId, bomb);
    await run(evidenceId);

    const row = await rowOf(evidenceId);
    expect(row.thumbnail_object_key).toBeNull();
    expect(row.media_processed_at).not.toBeNull();
  });
});

describe('§12.8 — the EXIF strip', () => {
  it('leaves a photograph the device already stripped byte-identical', async () => {
    // The ordinary case, and the reason the strip is structural rather than a re-encode:
    // `processCapturedPhoto` re-encodes on the device, so there is nothing to remove, and
    // the object in storage stays the object `checksum_sha256` describes.
    const { auditId, auditZoneId } = await walkByZone();
    const clean = await jpegOf(1200, 900);
    const { evidenceId, objectKey } = await capture(auditId, auditZoneId, clean);

    await run(evidenceId);

    const row = await rowOf(evidenceId);
    expect(row.stored_checksum_sha256).toBeNull();
    expect(await storage.get(objectKey)).toEqual(clean);
  });

  it('removes GPS and a comment a modified build sent, keeping the orientation', async () => {
    const { auditId, auditZoneId } = await walkByZone();
    const dirty = await jpegOf(1200, 900, { exif: true });

    // The fixture really does carry what §12.8 is about.
    expect(stripImageMetadata(dirty, 'image/jpeg')!.removed).toEqual(['APP1', 'COM']);
    expect(dirty.includes(Buffer.from('Shot on a modified build'))).toBe(true);

    const { evidenceId, objectKey } = await capture(auditId, auditZoneId, dirty);
    await run(evidenceId);

    const stored = await storage.get(objectKey);
    expect(stored.includes(Buffer.from('Shot on a modified build'))).toBe(false);
    // The GPS tag is gone by number, not merely shortened.
    expect(stored.includes(Buffer.from([0x88, 0x25, 0x00, 0x04]))).toBe(false);
    // Orientation survives — §12.8 exempts it — so the image does not print sideways.
    expect(stripImageMetadata(stored, 'image/jpeg')!.orientation).toBe(6);
    // And it is still a decodable image of the same size: a strip, not a re-encode.
    expect(readImageDimensions(stored)).toEqual({ width: 1200, height: 900 });

    const row = await rowOf(evidenceId);
    // Non-null is both the new verification value and the record that a sanitisation
    // happened (R-12c).
    expect(row.stored_checksum_sha256).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(row.stored_checksum_sha256).not.toBe(row.checksum_sha256);
    // The capture checksum is untouched: it is what the device asserted and what `commit`
    // verified, and that is a historical fact.
    expect(row.checksum_sha256).toBe(createHash('sha256').update(dirty).digest('hex'));
  });

  it('leaves a replayed commit working after the object was sanitised (§9.6)', async () => {
    // The bug `stored_checksum_sha256` exists to prevent. §9.6 makes replaying `commit`
    // the recovery path for an app killed between the PUT and the confirmation. With one
    // checksum column the replay would answer 409 CHECKSUM_MISMATCH for a photograph the
    // server itself rewrote, and the device would retry until it dead-lettered it.
    const { auditId, auditZoneId } = await walkByZone();
    const dirty = await jpegOf(600, 400, { exif: true });
    const { evidenceId } = await capture(auditId, auditZoneId, dirty);

    await run(evidenceId);

    const replay = await world.request('POST', `${base}/evidence/${evidenceId}/commit`, {
      token: consultantToken,
      headers: { 'x-device-id': DEVICE_ID },
      body: { checksumSha256: createHash('sha256').update(dirty).digest('hex') },
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect((replay.body as Evidence).syncState).toBe('SYNCED');
  });
});

describe('R-12d — the worker writes after the audit has completed', () => {
  it('records its three columns on a completed audit’s photograph', async () => {
    // The case the carve-out was widened for, and it is the ordinary one: §9.3 batches up
    // to 100 items, so a device pushes the last photograph and the completion together,
    // and the audit is COMPLETED long before the job is picked up.
    const { auditId, auditZoneId } = await walkByZone();
    const { evidenceId } = await capture(auditId, auditZoneId, await jpegOf(900, 600, { exif: true }));

    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });
    const completed = await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    // Its nonconformity photograph opened a corrective action (§7.1).
    expect((completed.body as Audit).status).toBe('CORRECTIVE_ACTION_OPEN');

    // Before 0008 widened the `TG_ARGV` list, this threw and the job dead-lettered.
    await run(evidenceId);

    const row = await rowOf(evidenceId);
    expect(row.thumbnail_object_key).not.toBeNull();
    expect(row.media_processed_at).not.toBeNull();
    expect(row.stored_checksum_sha256).not.toBeNull();
  });

  it('is still refused every audited column on that same row', async () => {
    // Widening a carve-out is only safe if it did not widen further than intended. The
    // application is refused here for the same reason the trigger refuses it: the audit
    // is frozen.
    const { auditId, auditZoneId } = await walkByZone();
    const { evidenceId } = await capture(auditId, auditZoneId, await jpegOf(300, 200));

    await world.request('POST', `${base}/audits/${auditId}/zones/${auditZoneId}/complete`, {
      token: consultantToken,
      body: {},
    });
    await world.request('POST', `${base}/audits/${auditId}/complete`, {
      token: consultantToken,
      body: {},
    });
    await run(evidenceId);

    const flagged = await world.request('PATCH', `${base}/evidence/${evidenceId}`, {
      token: consultantToken,
      body: { isSummaryFlagged: true },
    });
    expect(flagged.status).toBe(409);
    expect((flagged.body as { code: string }).code).toBe('AUDIT_ALREADY_COMPLETED');

    // And directly, with no service in the way.
    await expect(
      world.owner.query(`UPDATE evidence SET classification = 'GOOD' WHERE id = $1`, [evidenceId]),
    ).rejects.toThrow(/may not be updated after completion/);
  });
});

describe('the worker’s identity', () => {
  it('refuses to act for a user who is no longer usable', async () => {
    const { auditId, auditZoneId } = await walkByZone();
    const { evidenceId } = await capture(auditId, auditZoneId, await jpegOf(200, 150));

    await expect(
      worker.handle({ evidenceId, auditorUserId: randomUUID() }),
    ).rejects.toThrow(/no longer usable/);

    // Nothing was written on the way to the refusal.
    expect((await rowOf(evidenceId)).media_processed_at).toBeNull();
  });

  it('does nothing for a photograph the committing auditor cannot read', async () => {
    // A job can outlive the membership that made its photograph readable. Retrying would
    // never change the answer, so it is a warning rather than a throw.
    const { auditId, auditZoneId } = await walkByZone();
    const { evidenceId } = await capture(auditId, auditZoneId, await jpegOf(200, 150));

    await worker.handle({ evidenceId, auditorUserId: world.outOfScopeActor.userId });

    expect((await rowOf(evidenceId)).media_processed_at).toBeNull();
  });
});

describe('the queue is declared', () => {
  it('registers media.process alongside every other queue', async () => {
    // A queue that is never created accepts sends and delivers nothing. `QueueService`
    // creates all of `QUEUES` on boot; this is the assertion that the new name is in it.
    void world.app.get(QueueService);
    const { rows } = await world.owner.query(
      `SELECT name FROM pgboss.queue WHERE name = 'media.process'`,
    );
    expect(rows).toHaveLength(1);
  });
});
