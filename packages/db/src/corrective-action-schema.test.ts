import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  APP_URL,
  IDS,
  OWNER_URL,
  asActor,
  connect,
  migrate,
  resetFixtures,
  seedAuditFixture,
  seedFixtures,
} from './test-support';

/**
 * Migration 0009's guarantees, asserted against a real PostgreSQL.
 *
 * CA-1 and CA-2 are what make "3 of 5 submitted, 2 next week" safe by construction (§7.3):
 * an attempt, once written, is history. These tests issue the statements the services
 * never would, because the point of a database guarantee is that it holds for them too.
 */

let owner: Client;
let app: Client;

const P = {
  finding: '01930000-0000-7000-8000-0000000f0001',
  action: '01930000-0000-7000-8000-0000000f0002',
  attempt: '01930000-0000-7000-8000-0000000f0003',
  afterPhoto: '01930000-0000-7000-8000-0000000f0004',
  zoneLeaderB: '01930000-0000-7000-8000-0000000f0005',
};

beforeAll(async () => {
  migrate();
  owner = await connect(OWNER_URL);
  app = await connect(APP_URL);
});

afterAll(async () => {
  await owner?.end();
  await app?.end();
});

beforeEach(async () => {
  await resetFixtures(owner);
  await seedFixtures(owner);
});

/** A completed audit whose one Zone raised one nonconformity photo, and its action. */
async function seedOpenAction(): Promise<void> {
  const audit = await seedAuditFixture(owner);
  await owner.query(
    `INSERT INTO evidence (id, kind, audit_id, audit_zone_id, question_response_id, object_key,
                           content_type, byte_size, checksum_sha256, classification, captured_at,
                           is_live_capture, sync_state, uploaded_at)
     VALUES ($1, 'QUESTION_EVIDENCE', $2, $3, $4, 'evidence/finding.jpg', 'image/jpeg', 1000,
             $5, 'NONCONFORMITY', now(), true, 'SYNCED', now())`,
    [P.finding, audit.auditId, audit.auditZoneId, audit.responseId, 'a'.repeat(64)],
  );
  await owner.query(`UPDATE audit_zone SET status = 'COMPLETED' WHERE id = $1`, [audit.auditZoneId]);
  await owner.query(`UPDATE audit SET status = 'CORRECTIVE_ACTION_OPEN' WHERE id = $1`, [
    audit.auditId,
  ]);
  await owner.query(
    `INSERT INTO corrective_action (id, evidence_id, audit_id, audit_zone_id, unit_id, zone_id,
                                    checklist_question_id, assigned_zone_leader_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      P.action,
      P.finding,
      audit.auditId,
      audit.auditZoneId,
      IDS.unitA,
      audit.zoneId,
      audit.questionId,
      IDS.zoneLeaderA,
    ],
  );
}

/** The Zone Leader's live after-photo, taken for attempt `P.attempt`. */
async function insertAfterPhoto(
  client: Client,
  overrides: { live?: boolean; submissionId?: string } = {},
): Promise<void> {
  await client.query(
    `INSERT INTO evidence (id, kind, audit_id, corrective_action_id,
                           corrective_action_submission_id, object_key, content_type, byte_size,
                           checksum_sha256, captured_at, is_live_capture)
     VALUES ($1, 'CORRECTIVE_AFTER', $2, $3, $4, 'corrective/after.jpg', 'image/jpeg', 1000,
             $5, now(), $6)`,
    [
      P.afterPhoto,
      IDS.auditA,
      P.action,
      overrides.submissionId ?? P.attempt,
      'b'.repeat(64),
      overrides.live ?? true,
    ],
  );
}

async function insertOptionA(client: Client, afterEvidenceId: string | null = P.afterPhoto) {
  return client.query(
    `INSERT INTO corrective_action_submission (id, corrective_action_id, attempt_no, option,
                                               submitted_by_user_id, submitted_by_name,
                                               description, after_evidence_id, submitted_via)
     VALUES ($1, $2, 1, 'COMPLETED', $3, 'Leader One', 'Rack relabelled', $4, 'MOBILE')`,
    [P.attempt, P.action, IDS.zoneLeaderA, afterEvidenceId],
  );
}

describe('one action per nonconformity photograph', () => {
  it('refuses a second action for the same evidence', async () => {
    await seedOpenAction();
    await expect(
      owner.query(
        `INSERT INTO corrective_action (evidence_id, audit_id, audit_zone_id, unit_id, zone_id)
         SELECT evidence_id, audit_id, audit_zone_id, unit_id, zone_id
           FROM corrective_action WHERE id = $1`,
        [P.action],
      ),
    ).rejects.toThrow(/corrective_action_evidence_key/);
  });

  it('is never deleted', async () => {
    await seedOpenAction();
    await expect(owner.query(`DELETE FROM corrective_action`)).rejects.toThrow(/never deleted/);
  });
});

describe('CA-2', () => {
  it('refuses Option A without an after-photo', async () => {
    await seedOpenAction();
    await expect(insertOptionA(owner, null)).rejects.toThrow(/ca2_completed/);
  });

  it('refuses Option B without an explanation', async () => {
    await seedOpenAction();
    await expect(
      owner.query(
        `INSERT INTO corrective_action_submission (id, corrective_action_id, attempt_no, option,
                                                   submitted_by_user_id, submitted_by_name,
                                                   explanation, submitted_via)
         VALUES ($1, $2, 1, 'NOT_POSSIBLE', $3, 'Leader One', '   ', 'MOBILE')`,
        [P.attempt, P.action, IDS.zoneLeaderA],
      ),
    ).rejects.toThrow(/ca2_not_possible/);
  });

  it('refuses an after-photo that was not a live capture', async () => {
    await seedOpenAction();
    await insertAfterPhoto(owner, { live: false });
    await expect(insertOptionA(owner)).rejects.toThrow(/not a live capture/);
  });

  it('refuses an after-photo taken for a different attempt', async () => {
    await seedOpenAction();
    await insertAfterPhoto(owner, { submissionId: '01930000-0000-7000-8000-0000000f00ff' });
    await expect(insertOptionA(owner)).rejects.toThrow(/not an after-photo taken for/);
  });

  it('accepts a live after-photo taken for this attempt', async () => {
    await seedOpenAction();
    await insertAfterPhoto(owner);
    await insertOptionA(owner);
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM corrective_action_submission`);
    expect(rows[0].n).toBe(1);
  });
});

describe('CA-1 — an attempt is history', () => {
  beforeEach(async () => {
    await seedOpenAction();
    await insertAfterPhoto(owner);
    await insertOptionA(owner);
  });

  it('refuses rewriting what was submitted', async () => {
    await expect(
      owner.query(`UPDATE corrective_action_submission SET description = 'edited' WHERE id = $1`, [
        P.attempt,
      ]),
    ).rejects.toThrow(/may not be updated/);
  });

  it('records a review once, and refuses a second', async () => {
    await owner.query(
      `UPDATE corrective_action_submission
          SET review_outcome = 'REOPENED', reviewed_by_user_id = $2, reviewed_at = now(),
              review_comment = 'Label still missing'
        WHERE id = $1`,
      [P.attempt, IDS.superAdmin],
    );
    await expect(
      owner.query(
        `UPDATE corrective_action_submission SET review_outcome = 'VERIFIED' WHERE id = $1`,
        [P.attempt],
      ),
    ).rejects.toThrow(/already reviewed/);
  });

  it('refuses a duplicate attempt number', async () => {
    await expect(
      owner.query(
        `INSERT INTO corrective_action_submission (id, corrective_action_id, attempt_no, option,
                                                   submitted_by_user_id, submitted_by_name,
                                                   explanation, submitted_via)
         VALUES (gen_random_uuid(), $1, 1, 'NOT_POSSIBLE', $2, 'Leader One', 'No budget', 'MOBILE')`,
        [P.action, IDS.zoneLeaderA],
      ),
    ).rejects.toThrow(/corrective_action_submission_attempt_key/);
  });

  it('is never deleted', async () => {
    await expect(owner.query(`DELETE FROM corrective_action_submission`)).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('R-13 — an after-photo freezes when an attempt cites it, not before', () => {
  it('lets the after-photo commit on a completed audit', async () => {
    // The audit is CORRECTIVE_ACTION_OPEN, so R-10 would freeze any other evidence here.
    await seedOpenAction();
    await insertAfterPhoto(owner);
    await owner.query(
      `UPDATE evidence SET sync_state = 'SYNCED', uploaded_at = now() WHERE id = $1`,
      [P.afterPhoto],
    );
    const { rows } = await owner.query(`SELECT sync_state FROM evidence WHERE id = $1`, [
      P.afterPhoto,
    ]);
    expect(rows[0].sync_state).toBe('SYNCED');
  });

  it('freezes it once submitted, keeping the worker’s carve-out', async () => {
    await seedOpenAction();
    await insertAfterPhoto(owner);
    await insertOptionA(owner);

    await expect(
      owner.query(`UPDATE evidence SET remark = 'changed' WHERE id = $1`, [P.afterPhoto]),
    ).rejects.toThrow(/may not be updated after completion/);
    await owner.query(`UPDATE evidence SET media_processed_at = now() WHERE id = $1`, [
      P.afterPhoto,
    ]);
  });

  it('still freezes the finding it answers', async () => {
    await seedOpenAction();
    await expect(
      owner.query(`UPDATE evidence SET remark = 'changed' WHERE id = $1`, [P.finding]),
    ).rejects.toThrow(/may not be updated after completion/);
  });

  it('refuses the link on any other kind', async () => {
    await seedOpenAction();
    await expect(
      owner.query(`UPDATE evidence SET corrective_action_id = $2 WHERE id = $1`, [
        P.finding,
        P.action,
      ]),
    ).rejects.toThrow();
  });
});

describe('row-level security', () => {
  async function addZoneLeaderInUnitB(): Promise<void> {
    await owner.query(
      `INSERT INTO "user" (id, login_id, full_name, phone_e164, role, password_hash, status)
       VALUES ($1, 'ZL0005', 'Leader Two', '+919000000005', 'ZONE_LEADER', 'x', 'ACTIVE')`,
      [P.zoneLeaderB],
    );
    await owner.query(
      `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
       VALUES ($1, $2, 'ZONE_LEADER', $3)`,
      [P.zoneLeaderB, IDS.unitB, IDS.superAdmin],
    );
  }

  it('lets a Zone Leader of the Unit take the after-photo and submit', async () => {
    await seedOpenAction();
    await asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', async () => {
      await insertAfterPhoto(app);
      await insertOptionA(app);
    });
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM corrective_action_submission`);
    expect(rows[0].n).toBe(1);
  });

  it('refuses a Zone Leader of another Unit', async () => {
    await seedOpenAction();
    await addZoneLeaderInUnitB();
    await expect(
      asActor(app, P.zoneLeaderB, 'ZONE_LEADER', () => insertAfterPhoto(app)),
    ).rejects.toThrow(/row-level security/);
    const { rows } = await asActor(app, P.zoneLeaderB, 'ZONE_LEADER', () =>
      app.query(`SELECT id FROM corrective_action`),
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a Consultant’s submission, though they may read the item', async () => {
    await seedOpenAction();
    await insertAfterPhoto(owner);
    const { rows } = await asActor(app, IDS.consultant, 'CONSULTANT', () =>
      app.query(`SELECT id FROM corrective_action`),
    );
    expect(rows).toHaveLength(1);
    await expect(
      asActor(app, IDS.consultant, 'CONSULTANT', () => insertOptionA(app)),
    ).rejects.toThrow(/row-level security/);
  });

  it('keeps each notification to its recipient', async () => {
    const eventId = '01930000-0000-7000-8000-0000000f0010';
    await asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
      app.query(
        `INSERT INTO notification (event_id, recipient_user_id, event_type, title, body)
         VALUES ($1, $2, 'AUDIT_COMPLETED', 't', 'b')`,
        [eventId, IDS.zoneLeaderA],
      ),
    );
    await expect(
      asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
        app.query(
          `INSERT INTO notification (event_id, recipient_user_id, event_type, title, body)
           VALUES ($1, $2, 'AUDIT_COMPLETED', 't', 'b')`,
          [eventId, IDS.superAdmin],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const { rows } = await asActor(app, IDS.superAdmin, 'SUPER_ADMIN', () =>
      app.query(`SELECT id FROM notification`),
    );
    expect(rows).toHaveLength(0);
  });

  it('lets a notification be marked read and nothing else', async () => {
    await owner.query(
      `INSERT INTO notification (event_id, recipient_user_id, event_type, title, body)
       VALUES (gen_random_uuid(), $1, 'AUDIT_COMPLETED', 't', 'b')`,
      [IDS.zoneLeaderA],
    );
    await owner.query(`UPDATE notification SET read_at = now()`);
    await expect(owner.query(`UPDATE notification SET body = 'x'`)).rejects.toThrow(
      /may not be updated/,
    );
  });
});

describe('app_notification_targets', () => {
  it('finds Super Admins everywhere and other roles through the Unit, honouring switches', async () => {
    await owner.query(
      `INSERT INTO notification_preference (user_id, event_type, channel, enabled)
       VALUES ($1, 'AUDIT_COMPLETED', 'WHATSAPP', false)`,
      [IDS.coordinatorA],
    );
    const { rows } = await asActor(app, IDS.consultant, 'CONSULTANT', () =>
      app.query(
        `SELECT user_id, user_role, whatsapp_enabled, sms_enabled
           FROM app_notification_targets('AUDIT_COMPLETED', $1,
                                         ARRAY['SUPER_ADMIN','COORDINATOR']::role[], ARRAY[$2]::uuid[])
          ORDER BY user_role`,
        [IDS.unitB, IDS.zoneLeaderA],
      ),
    );
    // Unit B has no Coordinator, so only the Super Admin and the named Zone Leader.
    expect(rows.map((row) => row.user_id).sort()).toEqual([IDS.superAdmin, IDS.zoneLeaderA].sort());

    const inUnitA = await asActor(app, IDS.consultant, 'CONSULTANT', () =>
      app.query(
        `SELECT user_id, whatsapp_enabled FROM app_notification_targets(
           'AUDIT_COMPLETED', $1, ARRAY['COORDINATOR']::role[], ARRAY[]::uuid[])`,
        [IDS.unitA],
      ),
    );
    expect(inUnitA.rows).toEqual([{ user_id: IDS.coordinatorA, whatsapp_enabled: false }]);
  });
});
