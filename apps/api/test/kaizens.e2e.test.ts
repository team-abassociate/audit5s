import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import type { KaizenDashboard, KaizenDetail, KaizenExport, Page, Kaizen, SyncBatchResponse } from '@audit5s/contracts';
import { ObjectStorage } from '../src/infrastructure/storage/object-storage';
import { KaizenExportWorker } from '../src/modules/kaizens/kaizen-export.worker';
import { KaizenPhotoWorker } from '../src/modules/kaizens/kaizen-photo.worker';
import {
  TINY_JPEG,
  loginFromDevice,
  makeActor,
  sha256Hex,
  startWorld,
  stopWorld,
  type TestActor,
  type TestWorld,
} from './harness';

/**
 * Kaizen (R-48, plans/kaizen-module.md §4.2, §4.5): the authorization block for every role,
 * cross-Unit and cross-author IDOR, idempotency on every write, and the review transaction.
 */

const base = '/api/v1/kaizens';
let world: TestWorld;
/** A second Zone Leader of Unit A: same Unit, not the author. */
let otherLeader: TestActor;

const COMPLETE_SHEET = {
  machine: 'Press 4',
  lineArea: 'Line B',
  implementedOn: '2026-10-01',
  teamMembers: 'Asha, Ravi',
  theme: 'Cut changeover time',
  problem5w1h: 'Die change takes 40 minutes',
  countermeasure: 'Quick-release clamps',
  horizontalDeployment: true,
  benefits: 'Twenty minutes a shift',
  rootCause4m: 'Method',
  ideaBy: 'Asha',
  implementedBy: 'Ravi',
  annualSaving: 108000,
  wastes: ['WAITING_TIME', 'MOTION'],
  parameters: ['PRODUCTIVITY'],
};

beforeAll(async () => {
  world = await startWorld();
  otherLeader = await makeActor(world.owner, world.request, 'ZONE_LEADER', 'Omi Other', '+919000000106', world.unitA);
});

afterAll(async () => {
  await stopWorld(world);
});

const as = (actor: TestActor) => actor.accessToken;

async function create(actor: TestActor, body: Record<string, unknown> = {}, zoneId = world.zoneA) {
  const id = (body.id as string | undefined) ?? uuidv7();
  return world.request('POST', base, { token: as(actor), body: { id, zoneId, ...body } });
}

async function draft(actor: TestActor, zoneId = world.zoneA, sheet: Record<string, unknown> = COMPLETE_SHEET) {
  const response = await create(actor, sheet, zoneId);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as KaizenDetail;
}

async function submit(actor: TestActor, kaizenId: string, submissionId = randomUUID()) {
  return world.request('POST', `${base}/${kaizenId}/submit`, { token: as(actor), body: { submissionId } });
}

async function review(actor: TestActor, kaizenId: string, body: Record<string, unknown>, key = randomUUID()) {
  return world.request('POST', `${base}/${kaizenId}/review`, {
    token: as(actor),
    headers: { 'idempotency-key': key },
    body,
  });
}

async function submitted(actor: TestActor, zoneId = world.zoneA) {
  const kaizen = await draft(actor, zoneId);
  expect((await submit(actor, kaizen.id)).status).toBe(200);
  return kaizen;
}

async function reviewCount(kaizenId: string): Promise<number> {
  const { rows } = await world.owner.query('SELECT count(*)::int AS n FROM kaizen_review WHERE kaizen_id = $1', [kaizenId]);
  return rows[0].n as number;
}

describe('a DRAFT and its number', () => {
  it('is numbered by the database, KZ-{zone}-{count per Unit}, and a replay keeps it', async () => {
    const id = uuidv7();
    const first = await create(world.actors.ZONE_LEADER, { id, machine: 'Lathe' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const kaizen = first.body as KaizenDetail;
    expect(kaizen.kaizenNo).toMatch(/^KZ-Z01-\d{3}$/);
    expect(kaizen.status).toBe('DRAFT');
    expect(kaizen.authorName).toBe('Zoe Leader');

    const replay = await create(world.actors.ZONE_LEADER, { id, machine: 'Lathe 2' });
    expect(replay.status).toBe(201);
    expect((replay.body as KaizenDetail).kaizenNo).toBe(kaizen.kaizenNo);
    expect((replay.body as KaizenDetail).machine).toBe('Lathe 2');

    const next = await draft(world.actors.ZONE_LEADER);
    expect(Number(next.kaizenNo.slice(-3))).toBe(Number(kaizen.kaizenNo.slice(-3)) + 1);
  });

  it('refuses an id that is somebody else’s, without saying whose', async () => {
    const mine = await draft(world.actors.ZONE_LEADER);
    const theirs = await create(otherLeader, { id: mine.id });
    expect(theirs.status).toBe(409);
    const outside = await create(world.outOfScopeActor, { id: mine.id }, world.zoneB);
    expect(outside.status).toBe(409);
  });

  it('keeps the Zone it was filed under', async () => {
    const kaizen = await draft(world.actors.ZONE_LEADER);
    const { rows } = await world.owner.query(
      `INSERT INTO zone (unit_id, code, name) VALUES ($1, 'Z-09', 'Paint') RETURNING id`,
      [world.unitA],
    );
    const moved = await create(world.actors.ZONE_LEADER, { id: kaizen.id }, rows[0].id as string);
    expect(moved.status).toBe(409);
  });
});

describe('authorization: who reaches what (PART 6, owner 2026-10-07)', () => {
  let inA: KaizenDetail;
  let inB: KaizenDetail;

  beforeAll(async () => {
    inA = await submitted(world.actors.ZONE_LEADER);
    inB = await submitted(world.outOfScopeActor, world.zoneB);
  });

  it.each([
    ['SUPER_ADMIN', 200, 200],
    ['CONSULTANT', 200, 404],
    ['COORDINATOR', 200, 404],
    ['ZONE_LEADER', 200, 404],
  ] as const)('%s reads one Kaizen: own Unit %i, other Unit %i', async (role, inScope, outOfScope) => {
    const token = as(world.actors[role]);
    expect((await world.request('GET', `${base}/${inA.id}`, { token })).status).toBe(inScope);
    expect((await world.request('GET', `${base}/${inB.id}`, { token })).status).toBe(outOfScope);
  });

  it('a Zone Leader sees only their own Kaizens, not a colleague’s in the same Unit', async () => {
    expect((await world.request('GET', `${base}/${inA.id}`, { token: as(otherLeader) })).status).toBe(404);
    const list = await world.request('GET', base, { token: as(otherLeader) });
    expect((list.body as Page<Kaizen>).data.map((k) => k.id)).not.toContain(inA.id);

    const theirs = await world.request('GET', base, { token: as(world.actors.ZONE_LEADER) });
    const ids = (theirs.body as Page<Kaizen>).data.map((k) => k.id);
    expect(ids).toContain(inA.id);
    expect((theirs.body as Page<Kaizen>).data.every((k) => k.authorUserId === world.actors.ZONE_LEADER.userId)).toBe(true);
  });

  it('lists are scoped: a Coordinator sees their Unit and never the other', async () => {
    const list = await world.request('GET', `${base}?limit=200`, { token: as(world.actors.COORDINATOR) });
    const kaizens = (list.body as Page<Kaizen>).data;
    expect(kaizens.map((k) => k.id)).toContain(inA.id);
    expect(kaizens.every((k) => k.unitId === world.unitA)).toBe(true);
    // A unitId filter narrows; it never widens (AZ-2).
    const widened = await world.request('GET', `${base}?unitId=${world.unitB}`, { token: as(world.actors.COORDINATOR) });
    expect((widened.body as Page<Kaizen>).data).toEqual([]);
  });

  it('only a Zone Leader (or Super Admin) creates, and only in their own Unit', async () => {
    expect((await create(world.actors.COORDINATOR)).status).toBe(403);
    expect((await create(world.actors.CONSULTANT)).status).toBe(403);
    expect((await create(world.actors.ZONE_LEADER, {}, world.zoneB)).status).toBe(404);
    expect((await create(world.actors.SUPER_ADMIN, {}, world.zoneB)).status).toBe(201);
  });

  it('only the author edits, submits or adds a photo; anyone else reads it as absent', async () => {
    const kaizen = await draft(world.actors.ZONE_LEADER);
    for (const actor of [otherLeader, world.outOfScopeActor, world.actors.SUPER_ADMIN]) {
      const token = as(actor);
      expect((await world.request('PATCH', `${base}/${kaizen.id}`, { token, body: { machine: 'X' } })).status).toBe(404);
      expect((await submit(actor, kaizen.id)).status).toBe(404);
      expect((await photoIntent(actor, kaizen.id)).status).toBe(404);
    }
    for (const actor of [world.actors.COORDINATOR, world.actors.CONSULTANT]) {
      expect((await world.request('PATCH', `${base}/${kaizen.id}`, { token: as(actor), body: { machine: 'X' } })).status).toBe(403);
      expect((await submit(actor, kaizen.id)).status).toBe(403);
    }
  });

  it('only a Coordinator of the Unit (or Super Admin) reviews', async () => {
    const approve = { decision: 'APPROVED' };
    expect((await review(world.actors.ZONE_LEADER, inA.id, approve)).status).toBe(403);
    expect((await review(world.actors.CONSULTANT, inA.id, approve)).status).toBe(403);
    expect((await review(world.actors.COORDINATOR, inB.id, approve)).status).toBe(404);
    expect((await review(world.actors.SUPER_ADMIN, inB.id, approve)).status).toBe(200);
  });

  it('the dashboard counts only what the actor may read', async () => {
    const leader = await world.request('GET', `${base}/dashboard`, { token: as(otherLeader) });
    expect(leader.status).toBe(200);
    expect((leader.body as KaizenDashboard).kpi.submitted).toBe(0);
    const coordinator = await world.request('GET', `${base}/dashboard?unitId=${world.unitB}`, {
      token: as(world.actors.COORDINATOR),
    });
    expect((coordinator.body as KaizenDashboard).kpi.submitted).toBe(0);
  });
});

describe('the author’s moves', () => {
  it('a sheet missing required steps is not submittable, and says which', async () => {
    const kaizen = await draft(world.actors.ZONE_LEADER, world.zoneA, { machine: 'Press' });
    const response = await submit(world.actors.ZONE_LEADER, kaizen.id);
    expect(response.status).toBe(422);
    const fields = (response.body as { errors: Array<{ field: string }> }).errors.map((e) => e.field);
    expect(fields).toContain('theme');
    expect(fields).not.toContain('machine');
  });

  it('a submission is idempotent on its id, and freezes the sheet', async () => {
    const kaizen = await draft(world.actors.ZONE_LEADER);
    const submissionId = randomUUID();
    const first = await submit(world.actors.ZONE_LEADER, kaizen.id, submissionId);
    expect(first.status).toBe(200);
    expect((first.body as KaizenDetail).status).toBe('SUBMITTED');
    const replay = await submit(world.actors.ZONE_LEADER, kaizen.id, submissionId);
    expect(replay.status).toBe(200);
    expect((replay.body as KaizenDetail).submittedAt).toBe((first.body as KaizenDetail).submittedAt);

    expect((await submit(world.actors.ZONE_LEADER, kaizen.id)).status).toBe(409);
    const edit = await world.request('PATCH', `${base}/${kaizen.id}`, {
      token: as(world.actors.ZONE_LEADER),
      body: { machine: 'Changed' },
    });
    expect(edit.status).toBe(409);
    // A late copy of the create that says what the sheet says is a replay, not a conflict.
    expect((await create(world.actors.ZONE_LEADER, { id: kaizen.id, ...COMPLETE_SHEET })).status).toBe(201);
    expect((await create(world.actors.ZONE_LEADER, { id: kaizen.id, machine: 'Other' })).status).toBe(409);
  });
});

describe('the review transaction', () => {
  it('send back needs a reason; resubmit keeps the first submission time; approve is final', async () => {
    const kaizen = await submitted(world.actors.ZONE_LEADER);
    const coordinator = world.actors.COORDINATOR;

    expect((await review(coordinator, kaizen.id, { decision: 'SENT_BACK' })).status).toBe(422);
    expect((await review(coordinator, kaizen.id, { decision: 'REJECTED', comment: '  ' })).status).toBe(422);

    const sentBack = await review(coordinator, kaizen.id, { decision: 'SENT_BACK', comment: 'Add the after photo' });
    expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
    const back = sentBack.body as KaizenDetail;
    expect(back.status).toBe('SENT_BACK');
    expect(back.latestReview).toMatchObject({ decision: 'SENT_BACK', comment: 'Add the after photo', reviewerName: 'Cole Coord' });

    // The author reworks and resubmits.
    const edited = await world.request('PATCH', `${base}/${kaizen.id}`, {
      token: as(world.actors.ZONE_LEADER),
      body: { benefits: 'Thirty minutes a shift' },
    });
    expect(edited.status).toBe(200);
    const again = await submit(world.actors.ZONE_LEADER, kaizen.id);
    expect(again.status).toBe(200);
    expect((again.body as KaizenDetail).submittedAt).toBe(back.submittedAt);

    const approved = await review(coordinator, kaizen.id, { decision: 'APPROVED' });
    expect(approved.status).toBe(200);
    const detail = approved.body as KaizenDetail;
    expect(detail.status).toBe('APPROVED');
    expect(detail.reviews.map((r) => r.decision)).toEqual(['SENT_BACK', 'APPROVED']);

    expect((await review(coordinator, kaizen.id, { decision: 'REJECTED', comment: 'No' })).status).toBe(409);

    // Each move left its audit-log entry; the review rows and the log agree.
    const { rows } = await world.owner.query(
      `SELECT action FROM audit_log WHERE resource_type = 'kaizen' AND resource_id = $1 ORDER BY id`,
      [kaizen.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'kaizen.created',
      'kaizen.submitted',
      'kaizen.sent_back',
      'kaizen.submitted',
      'kaizen.approved',
    ]);
  });

  it('needs an Idempotency-Key, and a retried decision is recorded once', async () => {
    const kaizen = await submitted(world.actors.ZONE_LEADER);
    const missing = await world.request('POST', `${base}/${kaizen.id}/review`, {
      token: as(world.actors.COORDINATOR),
      body: { decision: 'APPROVED' },
    });
    expect(missing.status).toBe(422);

    const key = randomUUID();
    expect((await review(world.actors.COORDINATOR, kaizen.id, { decision: 'APPROVED' }, key)).status).toBe(200);
    expect((await review(world.actors.COORDINATOR, kaizen.id, { decision: 'APPROVED' }, key)).status).toBe(200);
    expect(await reviewCount(kaizen.id)).toBe(1);
  });

  it('two reviewers at once: one decides, the other is told, and one review row exists', async () => {
    const kaizen = await submitted(world.actors.ZONE_LEADER);
    const results = await Promise.all([
      review(world.actors.COORDINATOR, kaizen.id, { decision: 'APPROVED' }),
      review(world.actors.SUPER_ADMIN, kaizen.id, { decision: 'REJECTED', comment: 'Duplicate' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await reviewCount(kaizen.id)).toBe(1);
  });

  it('the database refuses a decision with no review behind it', async () => {
    const kaizen = await submitted(world.actors.ZONE_LEADER);
    await expect(world.owner.query(`UPDATE kaizen SET status = 'APPROVED' WHERE id = $1`, [kaizen.id])).rejects.toThrow(
      /needs its review/,
    );
  });
});

describe('photos ride the evidence pipeline', () => {
  it('intent → PUT → commit; the detail carries a short-lived view URL; a submitted Kaizen takes no new photo', async () => {
    const kaizen = await draft(world.actors.ZONE_LEADER);
    const photoId = randomUUID();
    const intent = await photoIntent(world.actors.ZONE_LEADER, kaizen.id, photoId);
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    const { uploadUrl, objectKey } = intent.body as { uploadUrl: string; objectKey: string };
    expect(objectKey).toBe(`kaizen/${world.unitA}/${kaizen.id}/${photoId}.jpg`);
    // Idempotent on the photo id.
    expect(((await photoIntent(world.actors.ZONE_LEADER, kaizen.id, photoId)).body as { alreadyExists: boolean }).alreadyExists).toBe(true);

    const early = await commit(world.actors.ZONE_LEADER, kaizen.id, photoId);
    expect(early.status).toBe(409);
    expect((early.body as { code: string }).code).toBe('EVIDENCE_NOT_UPLOADED');

    const put = await world.app.inject({
      method: 'PUT',
      url: uploadUrl.replace(/^https?:\/\/[^/]+/, ''),
      headers: { 'content-type': 'image/jpeg' },
      payload: TINY_JPEG,
    });
    expect(put.statusCode).toBe(200);
    expect((await commit(world.actors.ZONE_LEADER, kaizen.id, photoId, 'f'.repeat(64))).status).toBe(409);
    expect((await commit(world.actors.ZONE_LEADER, kaizen.id, photoId)).status).toBe(200);
    expect((await commit(world.actors.ZONE_LEADER, kaizen.id, photoId)).status).toBe(200);

    const detail = (await world.request('GET', `${base}/${kaizen.id}`, { token: as(world.actors.COORDINATOR) }))
      .body as KaizenDetail;
    expect(detail.beforePhoto?.id).toBe(photoId);
    expect(detail.beforePhoto?.viewUrl).toBeTruthy();
    const list = (await world.request('GET', base, { token: as(world.actors.ZONE_LEADER) })).body as Page<Kaizen>;
    expect(list.data.find((k) => k.id === kaizen.id)?.beforePhoto?.viewUrl).toBeNull();

    expect((await submit(world.actors.ZONE_LEADER, kaizen.id)).status).toBe(200);
    expect((await photoIntent(world.actors.ZONE_LEADER, kaizen.id)).status).toBe(409);
    const remove = await world.request('DELETE', `${base}/${kaizen.id}/photos/${photoId}`, {
      token: as(world.actors.ZONE_LEADER),
    });
    expect(remove.status).toBe(409);
  });

  it('a second photo for the same box replaces the first', async () => {
    const kaizen = await draft(world.actors.ZONE_LEADER);
    const first = randomUUID();
    const second = randomUUID();
    expect((await photoIntent(world.actors.ZONE_LEADER, kaizen.id, first)).status).toBe(201);
    expect((await photoIntent(world.actors.ZONE_LEADER, kaizen.id, second)).status).toBe(201);
    const { rows } = await world.owner.query(
      'SELECT id FROM kaizen_photo WHERE kaizen_id = $1 AND deleted_at IS NULL',
      [kaizen.id],
    );
    expect(rows.map((r) => r.id)).toEqual([second]);
  });
});

describe('the EXIF strip (§12.8), in worker-general', () => {
  it('removes metadata from what is stored, records the new checksum, and runs once', async () => {
    // A comment segment spliced after SOI: what a modified capture path would leave behind.
    const note = Buffer.from('Shot on a modified build');
    const dirty = Buffer.concat([
      TINY_JPEG.subarray(0, 2),
      Buffer.from([0xff, 0xfe, (note.length + 2) >> 8, (note.length + 2) & 0xff]),
      note,
      TINY_JPEG.subarray(2),
    ]);
    const kaizen = await draft(world.actors.ZONE_LEADER);
    const photoId = randomUUID();
    const intent = await world.request('POST', `${base}/${kaizen.id}/photos/upload-intent`, {
      token: as(world.actors.ZONE_LEADER),
      body: {
        id: photoId,
        kaizenId: kaizen.id,
        kind: 'AFTER',
        contentType: 'image/jpeg',
        byteSize: dirty.byteLength,
        checksumSha256: sha256Hex(dirty),
        capturedAt: new Date().toISOString(),
        isLiveCapture: true,
      },
    });
    const { objectKey } = intent.body as { objectKey: string };
    const storage = world.app.get(ObjectStorage);
    await storage.put(objectKey, dirty, 'image/jpeg');
    expect((await commit(world.actors.ZONE_LEADER, kaizen.id, photoId, sha256Hex(dirty))).status).toBe(200);

    const worker = world.app.get(KaizenPhotoWorker);
    await worker.handle({ photoId, userId: world.actors.ZONE_LEADER.userId });
    const stored = await storage.get(objectKey);
    expect(stored.includes(note)).toBe(false);
    const { rows } = await world.owner.query('SELECT stored_checksum_sha256 FROM kaizen_photo WHERE id = $1', [photoId]);
    expect(rows[0].stored_checksum_sha256).toBe(sha256Hex(stored));

    await worker.handle({ photoId, userId: world.actors.ZONE_LEADER.userId });
    expect(sha256Hex(await storage.get(objectKey))).toBe(sha256Hex(stored));
  });
});

describe('the Kaizen Sheet export (§4.6): a PDF, printed by worker-report', () => {
  let inA: KaizenDetail;
  let inB: KaizenDetail;

  beforeAll(async () => {
    inA = await submitted(world.actors.ZONE_LEADER);
    inB = await submitted(world.outOfScopeActor, world.zoneB);
  });

  const requestExport = (actor: TestActor, kaizenId: string) =>
    world.request('POST', `${base}/${kaizenId}/export`, { token: as(actor) });
  const exportStatus = (actor: TestActor, kaizenId: string, exportId: string) =>
    world.request('GET', `${base}/${kaizenId}/export/${exportId}`, { token: as(actor) });

  it.each([
    ['SUPER_ADMIN', 202, 202],
    ['CONSULTANT', 202, 404],
    ['COORDINATOR', 202, 404],
    ['ZONE_LEADER', 202, 404],
  ] as const)('%s exports: own Unit %i, other Unit %i', async (role, inScope, outOfScope) => {
    expect((await requestExport(world.actors[role], inA.id)).status).toBe(inScope);
    expect((await requestExport(world.actors[role], inB.id)).status).toBe(outOfScope);
  });

  it('a colleague Zone Leader cannot export another’s Kaizen', async () => {
    expect((await requestExport(otherLeader, inA.id)).status).toBe(404);
  });

  it('QUEUED → printed → READY with a short-lived download of a PDF; the id is bound to its Kaizen', async () => {
    const queued = await requestExport(world.actors.COORDINATOR, inA.id);
    const job = queued.body as KaizenExport;
    expect(job.status).toBe('QUEUED');
    expect(job.fileName).toMatch(/ - Zone \d+ .+ - \d{2} \w+ \d{4}\.pdf$/);
    expect(job.downloadUrl).toBeNull();
    expect((await exportStatus(world.actors.COORDINATOR, inA.id, job.exportId)).body).toMatchObject({ status: 'QUEUED' });

    // Another Kaizen's path, or an id nobody issued, reads as absent.
    const other = await draft(world.actors.ZONE_LEADER);
    expect((await exportStatus(world.actors.COORDINATOR, other.id, job.exportId)).status).toBe(404);
    expect((await exportStatus(world.actors.COORDINATOR, inA.id, randomUUID())).status).toBe(404);

    await world.app.get(KaizenExportWorker).handle({
      kaizenId: inA.id,
      exportId: job.exportId,
      userId: world.actors.COORDINATOR.userId,
    });

    const ready = (await exportStatus(world.actors.ZONE_LEADER, inA.id, job.exportId)).body as KaizenExport;
    expect(ready.status).toBe('READY');
    expect(ready.expiresIn).toBeLessThanOrEqual(300);
    const download = await world.app.inject({ method: 'GET', url: ready.downloadUrl!.replace(/^https?:\/\/[^/]+/, '') });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // Out of scope, a READY export is as absent as its Kaizen.
    expect((await exportStatus(world.outOfScopeActor, inA.id, job.exportId)).status).toBe(404);
  });
});

describe('discarding a draft (R-49, owner 2026-10-10)', () => {
  function discard(actor: TestActor, kaizenId: string, key: string | null = randomUUID()) {
    return world.request('POST', `${base}/${kaizenId}/discard`, {
      token: as(actor),
      ...(key ? { headers: { 'idempotency-key': key } } : {}),
    });
  }

  async function logged(kaizenId: string): Promise<number> {
    const { rows } = await world.owner.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE resource_id = $1 AND action = 'kaizen.discarded'`,
      [kaizenId],
    );
    return rows[0].n as number;
  }

  it('the author deletes their draft: it leaves every list and read, once, and a retry is a no-op', async () => {
    const leader = world.actors.ZONE_LEADER;
    const kaizen = await draft(leader);
    expect((await discard(leader, kaizen.id, null)).status).toBe(422);

    expect((await discard(leader, kaizen.id)).status).toBe(204);
    expect((await discard(leader, kaizen.id)).status).toBe(204);
    expect(await logged(kaizen.id)).toBe(1);

    for (const actor of [leader, world.actors.COORDINATOR, world.actors.SUPER_ADMIN]) {
      expect((await world.request('GET', `${base}/${kaizen.id}`, { token: as(actor) })).status).toBe(404);
      const list = await world.request('GET', `${base}?limit=100`, { token: as(actor) });
      expect((list.body as Page<Kaizen>).data.map((k) => k.id)).not.toContain(kaizen.id);
    }
    // The row stays: nothing is hard-deleted.
    const { rows } = await world.owner.query('SELECT discarded_at FROM kaizen WHERE id = $1', [kaizen.id]);
    expect(rows[0].discarded_at).not.toBeNull();

    expect((await world.request('PATCH', `${base}/${kaizen.id}`, { token: as(leader), body: { machine: 'X' } })).status).toBe(409);
    expect((await submit(leader, kaizen.id)).status).toBe(409);
    expect((await photoIntent(leader, kaizen.id)).status).toBe(409);
  });

  it('only the author, and only a DRAFT', async () => {
    const kaizen = await draft(world.actors.ZONE_LEADER);
    expect((await discard(otherLeader, kaizen.id)).status).toBe(404);
    expect((await discard(world.actors.COORDINATOR, kaizen.id)).status).toBe(403);

    const sent = await submitted(world.actors.ZONE_LEADER);
    expect((await discard(world.actors.ZONE_LEADER, sent.id)).status).toBe(409);
    expect(await logged(sent.id)).toBe(0);
  });

  it('over sync: created and discarded in one batch, and an edit arriving later changes nothing', async () => {
    const deviceId = randomUUID();
    const token = await loginFromDevice(world, world.actors.ZONE_LEADER, deviceId);
    const kaizenId = uuidv7();
    const upsert = (machine: string) => ({
      outboxId: randomUUID(),
      entityType: 'kaizen',
      entityId: kaizenId,
      operation: 'upsert',
      payload: { zoneId: world.zoneA, machine },
    });
    const push = async (items: unknown[]) => {
      const response = await world.request('POST', '/api/v1/sync/batch', {
        token,
        headers: { 'x-device-id': deviceId },
        body: { batchId: randomUUID(), deviceId, items },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (response.body as SyncBatchResponse).results.map((r) => r.status);
    };

    // Out of order on purpose: the server sorts the discard after the upsert.
    const discardItem = { outboxId: randomUUID(), entityType: 'kaizen', entityId: kaizenId, operation: 'discard', payload: {} };
    expect(await push([discardItem, upsert('Press 4')])).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(await push([upsert('Press 9')])).toEqual(['ACCEPTED']);

    const { rows } = await world.owner.query('SELECT machine, discarded_at FROM kaizen WHERE id = $1', [kaizenId]);
    expect(rows[0]).toMatchObject({ machine: 'Press 4' });
    expect(rows[0].discarded_at).not.toBeNull();
  });
});

describe('sync: the outbox reaches the same service', () => {
  it('a Kaizen drafted, photographed and submitted offline lands in one batch, and a replay creates nothing', async () => {
    const deviceId = randomUUID();
    const token = await loginFromDevice(world, world.actors.ZONE_LEADER, deviceId);
    const kaizenId = uuidv7();
    const photoId = randomUUID();
    const submissionId = randomUUID();
    const items = [
      // Out of order on purpose: the server sorts.
      {
        outboxId: randomUUID(),
        entityType: 'kaizen_submission',
        entityId: submissionId,
        operation: 'submit',
        payload: { kaizenId },
      },
      {
        outboxId: randomUUID(),
        entityType: 'kaizen_photo',
        entityId: photoId,
        operation: 'upsert',
        payload: {
          kaizenId,
          kind: 'AFTER',
          contentType: 'image/jpeg',
          byteSize: TINY_JPEG.byteLength,
          checksumSha256: sha256Hex(TINY_JPEG),
          capturedAt: new Date().toISOString(),
          isLiveCapture: false,
        },
      },
      {
        outboxId: randomUUID(),
        entityType: 'kaizen',
        entityId: kaizenId,
        operation: 'upsert',
        payload: { zoneId: world.zoneA, ...COMPLETE_SHEET },
      },
    ];
    const push = async (batchId: string) => {
      const response = await world.request('POST', '/api/v1/sync/batch', {
        token,
        headers: { 'x-device-id': deviceId },
        body: { batchId, deviceId, items },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body as SyncBatchResponse;
    };

    const batchId = randomUUID();
    const result = await push(batchId);
    expect(result.results.map((r) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED', 'ACCEPTED']);

    const detail = (await world.request('GET', `${base}/${kaizenId}`, { token })).body as KaizenDetail;
    expect(detail.status).toBe('SUBMITTED');
    expect(detail.kaizenNo).toMatch(/^KZ-Z01-/);
    expect(detail.afterPhoto?.id).toBe(photoId);

    expect((await push(batchId)).replayed).toBe(true);
    // The same items in a fresh batch (a device that lost the response) change nothing.
    expect((await push(randomUUID())).results.every((r) => r.status === 'ACCEPTED')).toBe(true);
    const { rows } = await world.owner.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE resource_id = $1 AND action = 'kaizen.submitted'`,
      [kaizenId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('a submission whose Kaizen has not arrived waits for it', async () => {
    const deviceId = randomUUID();
    const token = await loginFromDevice(world, world.actors.ZONE_LEADER, deviceId);
    const response = await world.request('POST', '/api/v1/sync/batch', {
      token,
      headers: { 'x-device-id': deviceId },
      body: {
        batchId: randomUUID(),
        deviceId,
        items: [
          {
            outboxId: randomUUID(),
            entityType: 'kaizen_submission',
            entityId: randomUUID(),
            operation: 'submit',
            payload: { kaizenId: uuidv7() },
          },
        ],
      },
    });
    expect((response.body as SyncBatchResponse).results[0]?.status).toBe('RETRY_AFTER_PARENT');
  });
});

function photoIntent(actor: TestActor, kaizenId: string, id = randomUUID()) {
  return world.request('POST', `${base}/${kaizenId}/photos/upload-intent`, {
    token: as(actor),
    body: {
      id,
      kaizenId,
      kind: 'BEFORE',
      contentType: 'image/jpeg',
      byteSize: TINY_JPEG.byteLength,
      checksumSha256: sha256Hex(TINY_JPEG),
      capturedAt: new Date().toISOString(),
      isLiveCapture: false,
    },
  });
}

function commit(actor: TestActor, kaizenId: string, photoId: string, checksum = sha256Hex(TINY_JPEG)) {
  return world.request('POST', `${base}/${kaizenId}/photos/${photoId}/commit`, {
    token: as(actor),
    body: { checksumSha256: checksum },
  });
}
