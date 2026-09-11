import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { IDS, OWNER_URL, connect, migrate, resetFixtures, seedAuditFixture, seedFixtures } from './test-support';

/**
 * Migration 0008's guarantees, asserted against a real PostgreSQL.
 *
 * Every statement below is issued as the schema owner, bypassing every line of application
 * code — which is the point. `ResponsesService` already refuses an answer on a Zone with no
 * pinned version, and `AuditsService` will refuse a walk-by that names a checklist. Those
 * are checks in code paths; these are properties of the data. "No questionnaire, no score"
 * (§2.7) is a claim Phase 7's report and Phase 8's metrics get to *assume*, and this file
 * is why they can.
 */

let owner: Client;

/** Distinct from `test-support`'s IDS, which seed a scored audit in the same Unit. */
const WALK_BY = {
  auditId: '01930000-0000-7000-8000-00000000b001',
  auditZoneId: '01930000-0000-7000-8000-00000000b002',
  zoneId: '01930000-0000-7000-8000-00000000b003',
};

beforeAll(async () => {
  migrate();
  owner = await connect(OWNER_URL);
});

afterAll(async () => {
  await owner?.end();
});

beforeEach(async () => {
  await resetFixtures(owner);
  await seedFixtures(owner);
});

/** A `WALK_BY` audit with one Zone and no checklist version anywhere. */
async function seedWalkBy(): Promise<void> {
  await owner.query(
    `INSERT INTO zone (id, unit_id, code, name, description)
     VALUES ($1, $2, 'Z-90', 'Boiler house', 'Behind the utility block')`,
    [WALK_BY.zoneId, IDS.unitA],
  );
  await owner.query(
    `INSERT INTO device (id, user_id, platform, model, os_version, app_version)
     VALUES ($1, $2, 'android', 'Pixel', '15', '1.0.0')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.deviceA, IDS.consultant],
  );
  await owner.query(
    `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id, owning_device_id,
                        started_at)
     VALUES ($1, $2, 'WALK_BY', 'IN_PROGRESS', $3, $4, now())`,
    [WALK_BY.auditId, IDS.unitA, IDS.consultant, IDS.deviceA],
  );
  await owner.query(
    `INSERT INTO audit_zone (id, audit_id, zone_id, sequence_no, status,
                             zone_code_snapshot, zone_name_snapshot, zone_description_snapshot)
     VALUES ($1, $2, $3, 1, 'IN_PROGRESS', 'Z-90', 'Boiler house', 'Behind the utility block')`,
    [WALK_BY.auditZoneId, WALK_BY.auditId, WALK_BY.zoneId],
  );
}

describe('a walk-by has no questionnaire (§2.7, §5.5)', () => {
  it('accepts a WALK_BY audit with no checklist version at all', async () => {
    // The whole point: `checklist_version_id` is already nullable, so this needs no
    // schema change — which is what made the "walk-by-specific constraints" row a
    // question about what should be *refused* rather than what should be added.
    await seedWalkBy();
    const { rows } = await owner.query(
      `SELECT checklist_version_id FROM audit WHERE id = $1`,
      [WALK_BY.auditId],
    );
    expect(rows[0].checklist_version_id).toBeNull();
  });

  it('refuses a WALK_BY audit that pins a checklist version', async () => {
    const scored = await seedAuditFixture(owner);

    await expect(
      owner.query(
        `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id,
                            checklist_version_id)
         VALUES (gen_random_uuid(), $1, 'WALK_BY', 'READY', $2, $3)`,
        [IDS.unitA, IDS.consultant, scored.versionId],
      ),
    ).rejects.toThrow(/audit_walk_by_has_no_checklist/);
  });

  it('refuses one that acquires a checklist version by UPDATE', async () => {
    // A CHECK covers the UPDATE as well as the INSERT, which an application-level
    // validation on the creation path would not.
    const scored = await seedAuditFixture(owner);
    await seedWalkBy();

    await expect(
      owner.query(`UPDATE audit SET checklist_version_id = $1 WHERE id = $2`, [
        scored.versionId,
        WALK_BY.auditId,
      ]),
    ).rejects.toThrow(/audit_walk_by_has_no_checklist/);
  });

  it('refuses a walk-by Zone that pins the binding version (QR-2)', async () => {
    // The audit-level column is a default; this is the one the report would render
    // questions from, so it is the one that matters.
    const scored = await seedAuditFixture(owner);
    await seedWalkBy();

    await expect(
      owner.query(`UPDATE audit_zone SET checklist_version_id = $1 WHERE id = $2`, [
        scored.versionId,
        WALK_BY.auditZoneId,
      ]),
    ).rejects.toThrow(/walk-by Zone has no questionnaire/);
  });

  it('leaves a scored audit’s Zones free to pin theirs', async () => {
    // The trigger has to be silent on the ordinary case, or it breaks every audit that
    // does have a questionnaire.
    const scored = await seedAuditFixture(owner);
    const { rows } = await owner.query(
      `SELECT checklist_version_id FROM audit_zone WHERE id = $1`,
      [scored.auditZoneId],
    );
    expect(rows[0].checklist_version_id).toBe(scored.versionId);
  });
});

describe('an answer needs its Zone’s pinned version (QR-2)', () => {
  it('refuses a question_response on a Zone that pinned none', async () => {
    // Which is to say: a walk-by Zone cannot be answered. Stated type-agnostically so
    // there is one rule rather than two that can drift.
    const scored = await seedAuditFixture(owner);
    await seedWalkBy();

    await expect(
      owner.query(
        `INSERT INTO question_response (id, audit_zone_id, audit_id, checklist_question_id,
                                        section, global_order, value, numeric_score, answered_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'S1_SORT', 1, 'SCORE_2', 2, now())`,
        [WALK_BY.auditZoneId, WALK_BY.auditId, scored.questionId],
      ),
    ).rejects.toThrow(/no checklist version pinned/);
  });

  it('still accepts the fifty answers of a scored Zone', async () => {
    const scored = await seedAuditFixture(owner);
    const { rows } = await owner.query(
      `SELECT COUNT(*)::int AS count FROM question_response WHERE audit_zone_id = $1`,
      [scored.auditZoneId],
    );
    // The fixture itself writes one through the same trigger; if it fired wrongly, the
    // fixture would not have been able to seed.
    expect(rows[0].count).toBe(1);
  });

  it('refuses moving an existing answer onto an unpinned Zone', async () => {
    const scored = await seedAuditFixture(owner);
    await seedWalkBy();

    await expect(
      owner.query(`UPDATE question_response SET audit_zone_id = $1 WHERE id = $2`, [
        WALK_BY.auditZoneId,
        scored.responseId,
      ]),
    ).rejects.toThrow(/no checklist version pinned/);
  });
});

describe('R-12 — the media worker’s three columns, after completion', () => {
  const evidenceId = '01930000-0000-7000-8000-0000000e0001';

  async function insertWalkByPhoto(): Promise<void> {
    await owner.query(
      `INSERT INTO evidence (id, kind, audit_id, audit_zone_id, object_key, content_type,
                             byte_size, checksum_sha256, classification, captured_at,
                             is_live_capture, sync_state, uploaded_at)
       VALUES ($1, 'WALK_BY_PHOTO', $2, $3, $4, 'image/jpeg', 120000, $5, 'NONCONFORMITY',
               now(), true, 'SYNCED', now())`,
      [
        evidenceId,
        WALK_BY.auditId,
        WALK_BY.auditZoneId,
        `evidence/${IDS.unitA}/${WALK_BY.auditId}/${WALK_BY.auditZoneId}/${evidenceId}.jpg`,
        'b'.repeat(64),
      ],
    );
  }

  /** Completes the walk-by audit, which is what arms R-10's trigger. */
  async function completeWalkBy(): Promise<void> {
    await owner.query(`UPDATE audit_zone SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [
      WALK_BY.auditZoneId,
    ]);
    await owner.query(`UPDATE audit SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [
      WALK_BY.auditId,
    ]);
  }

  it('lets the worker write a thumbnail after the audit has completed', async () => {
    // The case that made the carve-out necessary: a device pushes the last photograph and
    // the completion in one batch, so the audit is COMPLETED before the job is picked up.
    // Without these names the job would fail on every attempt and dead-letter.
    await seedWalkBy();
    await insertWalkByPhoto();
    await completeWalkBy();

    await owner.query(
      `UPDATE evidence
          SET thumbnail_object_key = $2, media_processed_at = now(),
              stored_checksum_sha256 = $3
        WHERE id = $1`,
      [evidenceId, 'evidence/thumb.jpg', 'c'.repeat(64)],
    );

    const { rows } = await owner.query(
      `SELECT thumbnail_object_key, media_processed_at IS NOT NULL AS processed,
              stored_checksum_sha256
         FROM evidence WHERE id = $1`,
      [evidenceId],
    );
    expect(rows[0].thumbnail_object_key).toBe('evidence/thumb.jpg');
    expect(rows[0].processed).toBe(true);
    expect(rows[0].stored_checksum_sha256).toBe('c'.repeat(64));
  });

  it('still refuses every audited column after completion', async () => {
    // Widening a carve-out is only safe if it did not widen further than intended. These
    // are the columns the rule exists for: what the photograph is, what it shows, and
    // whether it is the Zone's summary.
    await seedWalkBy();
    await insertWalkByPhoto();
    await completeWalkBy();

    for (const [column, value] of [
      ['classification', `'GOOD'`],
      ['is_summary_flagged', 'true'],
      ['remark', `'rewritten after the fact'`],
      ['object_key', `'evidence/somewhere-else.jpg'`],
      ['checksum_sha256', `'${'d'.repeat(64)}'`],
      ['captured_at', 'now()'],
      ['deleted_at', 'now()'],
      ['latitude', '19.9975'],
    ] as const) {
      await expect(
        owner.query(`UPDATE evidence SET ${column} = ${value} WHERE id = $1`, [evidenceId]),
        `evidence.${column} must still be frozen after completion`,
      ).rejects.toThrow(/may not be updated after completion/);
    }
  });

  it('keeps DELETE with no carve-out at any level', async () => {
    // R-5: erasure is redaction. There is no flag, no status and no role that turns this
    // into a deletion.
    await seedWalkBy();
    await insertWalkByPhoto();

    await expect(owner.query(`DELETE FROM evidence WHERE id = $1`, [evidenceId])).rejects.toThrow(
      /Evidence is never deleted/,
    );

    await completeWalkBy();
    await expect(owner.query(`DELETE FROM evidence WHERE id = $1`, [evidenceId])).rejects.toThrow(
      /Evidence is never deleted/,
    );
  });

  it('leaves R-5’s three redaction columns writable, as 0007 had them', async () => {
    // The carve-out was widened, not replaced.
    await seedWalkBy();
    await insertWalkByPhoto();
    await completeWalkBy();

    await owner.query(
      `UPDATE evidence SET redacted_at = now(), redacted_by_user_id = $2,
                           redaction_reason = 'Data-subject request'
        WHERE id = $1`,
      [evidenceId, IDS.superAdmin],
    );

    const { rows } = await owner.query(
      `SELECT redaction_reason FROM evidence WHERE id = $1`,
      [evidenceId],
    );
    expect(rows[0].redaction_reason).toBe('Data-subject request');
  });
});
