import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE } from '../src/common/auth/system-scope';
import { IntegrityWorker } from '../src/modules/maintenance/integrity.worker';
import { NotificationWorker } from '../src/modules/notifications/notification.worker';
import { startWorld, stopWorld, type TestWorld } from './harness';
import { drainNotifications, forgetQueuedNotifications } from './corrective-fixtures';

/**
 * §16.4's data-integrity jobs, and R-17's answer to "surfaced to Super Admin" — through
 * what?
 *
 * Each of the four checks is seeded in Unit A with exactly one finding, and the same faults
 * are seeded in Unit B. The sweep is scheduled per Unit, so Unit B's rows appearing in Unit
 * A's counts would be the scope bug this suite exists to catch — a count is the one shape
 * of result where a missing predicate looks like a plausible number rather than an error.
 *
 * The API process registers no workers here, exactly as in production, so the sweep and the
 * notification fan-out are both invoked directly.
 */

let world: TestWorld;
let integrity: IntegrityWorker;
let notifications: NotificationWorker;

/** The audit whose stored score is wrong. Kept, so the sweep can be shown not to fix it. */
let driftedAuditId: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeAll(async () => {
  world = await startWorld();
  integrity = world.app.get(IntegrityWorker);
  notifications = world.app.get(NotificationWorker);

  const versionId = await seedChecklist();
  driftedAuditId = await seedUnit(world.unitA, world.zoneA, versionId);
  await seedUnit(world.unitB, world.zoneB, versionId);

  // Anything an earlier step queued is not this suite's subject.
  await forgetQueuedNotifications(world);
}, 180_000);

afterAll(async () => stopWorld(world));

describe('nightly data-integrity checks (§16.4)', () => {
  it('finds one of each fault, and counts only its own Unit', async () => {
    const findings = await integrity.sweep(SYSTEM_SCOPE, world.unitA);

    expect(findings).toEqual({
      // The `SYNCING` evidence row from three days ago. The `SYNCED` one and the redacted
      // one are not faults: one arrived, and the other's object is gone on purpose (R-5).
      orphanEvidence: 1,
      // The audit started ten days ago. The paused one is two days old and is a device
      // finding, not a stale-audit one.
      staleAudits: 1,
      unsyncedDevices: 1,
      // Of the two completed audits, the one whose stored raw score says 4 and whose
      // responses say 2.
      scoreDrift: 1,
      auditsSampled: 2,
    });
  });

  it('changes nothing it finds', async () => {
    const { rows } = await world.owner.query(
      `SELECT raw_score, max_score, total_score FROM audit WHERE id = $1`,
      [driftedAuditId],
    );

    // A sweep that quietly rewrote the score would destroy the evidence that it was ever
    // wrong, which is the one thing §16.4 exists to preserve.
    expect(rows[0]).toMatchObject({ raw_score: 4, max_score: 4 });
  });

  it('reaches every Super Admin through the notification centre, and nobody else', async () => {
    await drainNotifications(world, notifications);

    const alerts = await notificationRows('DATA_INTEGRITY_ALERT');
    expect(alerts).toHaveLength(1);
    const [alert] = alerts;
    expect(alert).toMatchObject({
      recipient_user_id: world.actors.SUPER_ADMIN.userId,
      unit_id: world.unitA,
      title: 'Data integrity check',
    });
    expect(alert!.body).toBe(
      '1 evidence row without an uploaded photograph; ' +
        '1 audit open for more than a week; ' +
        '1 device holding an audit and not syncing; ' +
        '1 audit score that does not match a recomputation (of 2 checked). Nothing was changed.',
    );

    // The counts survive as data, so a later reader can act on them without re-parsing prose.
    expect(alert!.data).toMatchObject({ orphanEvidence: 1, scoreDrift: 1, auditsSampled: 2 });
    // In-app only: no WhatsApp or SMS row for an alert raised at 02:00.
    expect(alert!.channels).toEqual(['IN_APP']);
  });

  it('says nothing on a clean Unit', async () => {
    const unitId = randomUUID();
    await world.owner.query(
      `INSERT INTO unit (id, code, name, timezone) VALUES ($1, 'CLEAN', 'Clean Unit', 'Asia/Kolkata')`,
      [unitId],
    );

    const findings = await integrity.sweep(SYSTEM_SCOPE, unitId);

    expect(findings).toEqual({
      orphanEvidence: 0,
      staleAudits: 0,
      unsyncedDevices: 0,
      scoreDrift: 0,
      auditsSampled: 0,
    });
    // A nightly "all clear" is a nightly notification (R-17b).
    await drainNotifications(world, notifications);
    expect(await notificationRows('DATA_INTEGRITY_ALERT')).toHaveLength(1);
  });
});

async function notificationRows(eventType: string) {
  const { rows } = await world.owner.query(
    `SELECT n.recipient_user_id, n.unit_id, n.title, n.body, n.data,
            coalesce(array_agg(d.channel::text ORDER BY d.channel)
                     FILTER (WHERE d.id IS NOT NULL), '{}') AS channels
       FROM notification n LEFT JOIN notification_delivery d ON d.notification_id = n.id
      WHERE n.event_type = $1
      GROUP BY n.id ORDER BY n.created_at`,
    [eventType],
  );
  return rows as Array<{
    recipient_user_id: string;
    unit_id: string;
    title: string;
    body: string;
    data: Record<string, number>;
    channels: string[];
  }>;
}

/** Two questions in one section — enough for a score that can be stored wrongly. */
async function seedChecklist(): Promise<string> {
  const templateId = randomUUID();
  const versionId = randomUUID();
  await world.owner.query(
    `INSERT INTO checklist_template (id, code, name, sort_order) VALUES ($1, 'INTEGRITY', 'Integrity', 1)`,
    [templateId],
  );
  await world.owner.query(
    `INSERT INTO checklist_version (id, template_id, version_number, status, total_questions,
       questions_per_section, content_hash, published_at)
     VALUES ($1, $2, 1, 'DRAFT', 50, 10, 'integrity-v1', NULL)`,
    [versionId, templateId],
  );
  for (const order of [1, 2]) {
    await world.owner.query(
      `INSERT INTO checklist_question (id, version_id, section, order_in_section, global_order, text)
       VALUES (gen_random_uuid(), $1, 'S1_SORT', $2, $2, $3)`,
      [versionId, order, `Integrity question ${order}`],
    );
  }
  // CV-1: questions are immutable once published, so the version is published after them.
  await world.owner.query(
    `UPDATE checklist_version SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [versionId],
  );
  return versionId;
}

/** One of each §16.4 fault, in one Unit. Returns the audit whose stored score is wrong. */
async function seedUnit(unitId: string, zoneId: string, versionId: string): Promise<string> {
  // Scored and correct: SCORE_2 + SCORE_0 is 2 of 4, and that is what is stored.
  const honest = await completedAudit(unitId, zoneId, versionId, { rawScore: 2 });
  // Scored and wrong: the same two answers, stored as full marks.
  const drifted = await completedAudit(unitId, zoneId, versionId, { rawScore: 4 });

  // An evidence row whose object never arrived, old enough to count …
  await evidenceRow(honest, 'SYNCING', ago(3 * DAY_MS));
  // … one that did arrive …
  await evidenceRow(drifted, 'SYNCED', ago(3 * DAY_MS));
  // … and one erased on purpose, whose object is *meant* to be gone (R-5).
  await evidenceRow(honest, 'SYNCING', ago(3 * DAY_MS), { redacted: true });

  await world.owner.query(
    `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id, checklist_version_id, started_at)
     VALUES (gen_random_uuid(), $1, 'EXTERNAL_5S', 'IN_PROGRESS', $2, $3, $4)`,
    [unitId, world.actors.CONSULTANT.userId, versionId, ago(10 * DAY_MS)],
  );

  const deviceId = randomUUID();
  await world.owner.query(
    `INSERT INTO device (id, user_id, platform, last_seen_at, last_sync_at)
     VALUES ($1, $2, 'android', $3, $3)`,
    [deviceId, world.actors.CONSULTANT.userId, ago(5 * DAY_MS)],
  );
  await world.owner.query(
    `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id, checklist_version_id,
       owning_device_id, started_at, paused_at)
     VALUES (gen_random_uuid(), $1, 'EXTERNAL_5S', 'PAUSED', $2, $3, $4, $5, $5)`,
    [unitId, world.actors.CONSULTANT.userId, versionId, deviceId, ago(2 * DAY_MS)],
  );

  // A walk-by has no score to reconcile (§2.7) and must not enlarge the sample.
  await world.owner.query(
    `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id, started_at, completed_at)
     VALUES (gen_random_uuid(), $1, 'WALK_BY', 'CLOSED', $2, $3, $3)`,
    [unitId, world.actors.CONSULTANT.userId, ago(1 * DAY_MS)],
  );

  return drifted;
}

async function completedAudit(
  unitId: string,
  zoneId: string,
  versionId: string,
  stored: { rawScore: number },
): Promise<string> {
  const auditId = randomUUID();
  const auditZoneId = randomUUID();
  const completedAt = ago(DAY_MS);

  await world.owner.query(
    `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id, checklist_version_id,
       started_at, completed_at, raw_score, max_score, applicable_questions, na_questions, total_score)
     VALUES ($1, $2, 'EXTERNAL_5S', 'CLOSED', $3, $4, $5::timestamptz - interval '30 minutes', $5,
       $6, 4, 2, 0, $7)`,
    [auditId, unitId, world.actors.CONSULTANT.userId, versionId, completedAt, stored.rawScore,
      ((stored.rawScore / 4) * 100).toFixed(3)],
  );
  await world.owner.query(
    `INSERT INTO audit_zone (id, audit_id, zone_id, sequence_no, status, zone_code_snapshot,
       zone_name_snapshot, checklist_version_id, checklist_template_name_snapshot, completed_at,
       raw_score, max_score, applicable_questions, na_questions, score_percentage)
     VALUES ($1, $2, $3, 1, 'COMPLETED', 'Z-01', 'Press', $4, 'Integrity', $5, $6, 4, 2, 0, $7)`,
    [auditZoneId, auditId, zoneId, versionId, completedAt, stored.rawScore,
      ((stored.rawScore / 4) * 100).toFixed(3)],
  );

  const { rows } = await world.owner.query(
    `SELECT id, global_order FROM checklist_question WHERE version_id = $1 ORDER BY global_order`,
    [versionId],
  );
  for (const [index, question] of (rows as Array<{ id: string; global_order: number }>).entries()) {
    await world.owner.query(
      `INSERT INTO question_response (id, audit_zone_id, audit_id, checklist_question_id,
         section, global_order, value, numeric_score, answered_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'S1_SORT', $4, $5, $6, $7)`,
      [auditZoneId, auditId, question.id, question.global_order,
        index === 0 ? 'SCORE_2' : 'SCORE_0', index === 0 ? 2 : 0, completedAt],
    );
  }
  return auditId;
}

async function evidenceRow(
  auditId: string,
  syncState: string,
  createdAt: string,
  options: { redacted?: boolean } = {},
): Promise<void> {
  const id = randomUUID();
  await world.owner.query(
    `INSERT INTO evidence (id, kind, audit_id, object_key, content_type, byte_size,
       checksum_sha256, captured_at, sync_state, created_at, redacted_at, redaction_reason)
     VALUES ($1, 'AUDITOR_SELFIE', $2, $3, 'image/jpeg', 1024, $4, $5, $6, $5, $7, $8)`,
    [id, auditId, `selfie/${auditId}/${id}.jpg`, id.replaceAll('-', '').repeat(2), createdAt,
      syncState, options.redacted ? createdAt : null, options.redacted ? 'subject request' : null],
  );
}
