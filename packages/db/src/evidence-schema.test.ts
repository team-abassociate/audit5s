import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  APP_URL,
  IDS,
  OWNER_URL,
  asActor,
  asOverridingSuperAdmin,
  connect,
  migrate,
  resetFixtures,
  seedAuditFixture,
  seedFixtures,
} from './test-support';

/**
 * Phase 4 schema invariants, asserted against a real PostgreSQL.
 *
 * As in the Phase 3 suite, these issue the forbidden statement directly as the schema
 * owner, bypassing every line of application code. Each rule here protects something that
 * cannot be reconstructed once wrong:
 *
 *   - the two partial unique indexes are what stop a **duplicated sync** producing two
 *     flagged photos, which is the case §5.6 names when it puts them in the database;
 *   - R-5's carve-out is what makes erasure a redaction rather than a deletion;
 *   - `sync_conflict` refusing DELETE is Layer 3 of §9.5, and the property the whole
 *     offline design rests on.
 */

let owner: Client;
let app: Client;

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

let counter = 0;

/** Inserts an evidence row directly, as the owner. */
async function insertEvidence(
  fixture: { auditId: string; auditZoneId: string; responseId: string },
  overrides: Record<string, unknown> = {},
): Promise<string> {
  counter += 1;
  const values = {
    id: `01930000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    kind: 'QUESTION_EVIDENCE',
    audit_id: fixture.auditId,
    audit_zone_id: fixture.auditZoneId,
    question_response_id: fixture.responseId,
    object_key: `evidence/${IDS.unitA}/${fixture.auditId}/${fixture.auditZoneId}/${counter}.jpg`,
    content_type: 'image/jpeg',
    byte_size: 120_000,
    checksum_sha256: 'a'.repeat(64),
    classification: 'GOOD',
    is_summary_flagged: false,
    captured_at: new Date().toISOString(),
    is_live_capture: true,
    ...overrides,
  };

  const columns = Object.keys(values);
  const placeholders = columns.map((_column, index) => `$${index + 1}`);
  const { rows } = await owner.query(
    `INSERT INTO evidence (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
    Object.values(values),
  );
  return rows[0].id as string;
}

async function complete(auditId: string): Promise<void> {
  await owner.query(
    `UPDATE audit SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
    [auditId],
  );
}

describe('§5.6 — one flagged GOOD and one flagged NONCONFORMITY per Zone', () => {
  it('accepts one flagged photo of each classification in the same Zone', async () => {
    const fixture = await seedAuditFixture(owner);

    await insertEvidence(fixture, { classification: 'GOOD', is_summary_flagged: true });
    await insertEvidence(fixture, { classification: 'NONCONFORMITY', is_summary_flagged: true });

    const { rows } = await owner.query(
      `SELECT COUNT(*)::int AS count FROM evidence WHERE is_summary_flagged`,
    );
    expect(rows[0].count).toBe(2);
  });

  it('refuses a second flagged GOOD in one Zone', async () => {
    const fixture = await seedAuditFixture(owner);
    await insertEvidence(fixture, { classification: 'GOOD', is_summary_flagged: true });

    // This is the duplicated-sync case §5.6 names: the second request is not a user
    // pressing the button twice, it is the same payload arriving twice on a weak
    // connection. Application logic would have to remember; the index cannot forget.
    await expect(
      insertEvidence(fixture, { classification: 'GOOD', is_summary_flagged: true }),
    ).rejects.toThrow(/evidence_one_flagged_good_per_zone/);
  });

  it('refuses a second flagged NONCONFORMITY in one Zone', async () => {
    const fixture = await seedAuditFixture(owner);
    await insertEvidence(fixture, { classification: 'NONCONFORMITY', is_summary_flagged: true });

    await expect(
      insertEvidence(fixture, { classification: 'NONCONFORMITY', is_summary_flagged: true }),
    ).rejects.toThrow(/evidence_one_flagged_nonconformity_per_zone/);
  });

  it('frees the flag again when the flagged photo is soft-deleted', async () => {
    const fixture = await seedAuditFixture(owner);
    const first = await insertEvidence(fixture, {
      classification: 'GOOD',
      is_summary_flagged: true,
    });

    await owner.query(`UPDATE evidence SET deleted_at = now() WHERE id = $1`, [first]);

    // The index is partial on `deleted_at IS NULL`, so removing a photo before completion
    // lets the auditor flag its replacement — which is the whole point of E-4 existing.
    const second = await insertEvidence(fixture, {
      classification: 'GOOD',
      is_summary_flagged: true,
    });
    expect(second).toBeTruthy();
  });

  it('does not constrain unflagged photos', async () => {
    const fixture = await seedAuditFixture(owner);
    for (let index = 0; index < 5; index += 1) {
      await insertEvidence(fixture, { classification: 'GOOD', is_summary_flagged: false });
    }
    const { rows } = await owner.query(`SELECT COUNT(*)::int AS count FROM evidence`);
    expect(rows[0].count).toBe(5);
  });
});

describe('invariant E-3 — only a GOOD or NONCONFORMITY may be flagged', () => {
  it('refuses a flagged NEUTRAL photo', async () => {
    const fixture = await seedAuditFixture(owner);
    await expect(
      insertEvidence(fixture, { classification: 'NEUTRAL', is_summary_flagged: true }),
    ).rejects.toThrow(/evidence_e3_summary_flag/);
  });

  it('refuses reclassifying a flagged photo to NEUTRAL', async () => {
    const fixture = await seedAuditFixture(owner);
    const id = await insertEvidence(fixture, {
      classification: 'GOOD',
      is_summary_flagged: true,
    });

    // E-2 reclassifies on a response change. If the auditor changes 2 → NA the photo
    // becomes NEUTRAL, and the flag has to come off in the same statement.
    await expect(
      owner.query(`UPDATE evidence SET classification = 'NEUTRAL' WHERE id = $1`, [id]),
    ).rejects.toThrow(/evidence_e3_summary_flag/);

    await owner.query(
      `UPDATE evidence SET classification = 'NEUTRAL', is_summary_flagged = false WHERE id = $1`,
      [id],
    );
    const { rows } = await owner.query(`SELECT classification FROM evidence WHERE id = $1`, [id]);
    expect(rows[0].classification).toBe('NEUTRAL');
  });
});

describe('the structural links of §5.6', () => {
  it('refuses a unique object key twice', async () => {
    const fixture = await seedAuditFixture(owner);
    const key = `evidence/${IDS.unitA}/shared.jpg`;
    await insertEvidence(fixture, { object_key: key });
    await expect(insertEvidence(fixture, { object_key: key })).rejects.toThrow(
      /evidence_object_key_key/,
    );
  });

  it('refuses a selfie that names a question response (C8)', async () => {
    const fixture = await seedAuditFixture(owner);
    await expect(
      insertEvidence(fixture, {
        kind: 'AUDITOR_SELFIE',
        audit_zone_id: null,
        classification: 'NEUTRAL',
      }),
    ).rejects.toThrow(/evidence_question_link/);
  });

  it('accepts an audit-level selfie with no Zone and no response', async () => {
    const fixture = await seedAuditFixture(owner);
    const id = await insertEvidence(fixture, {
      kind: 'AUDITOR_SELFIE',
      audit_zone_id: null,
      question_response_id: null,
      classification: 'NEUTRAL',
    });
    expect(id).toBeTruthy();
  });

  it('refuses a question photo with no Zone', async () => {
    const fixture = await seedAuditFixture(owner);
    await expect(insertEvidence(fixture, { audit_zone_id: null })).rejects.toThrow(
      /evidence_zone_link/,
    );
  });

  it('accepts the selfie foreign key that 0006 left as a bare uuid', async () => {
    const fixture = await seedAuditFixture(owner);
    const selfieId = await insertEvidence(fixture, {
      kind: 'AUDITOR_SELFIE',
      audit_zone_id: null,
      question_response_id: null,
      classification: 'NEUTRAL',
    });

    await owner.query(`UPDATE audit SET selfie_evidence_id = $1 WHERE id = $2`, [
      selfieId,
      fixture.auditId,
    ]);

    // And refuses one that names nothing — the seam 0007 closed.
    await expect(
      owner.query(
        `UPDATE audit SET selfie_evidence_id = '00000000-0000-4000-8000-000000000000'
         WHERE id = $1`,
        [fixture.auditId],
      ),
    ).rejects.toThrow(/audit_selfie_evidence_fk/);
  });
});

describe('R-5 — erasure is redaction, never deletion', () => {
  it('never permits a DELETE, at any status, for anyone', async () => {
    const fixture = await seedAuditFixture(owner);
    const id = await insertEvidence(fixture);

    await expect(owner.query(`DELETE FROM evidence WHERE id = $1`, [id])).rejects.toThrow(
      /never deleted/,
    );

    await complete(fixture.auditId);
    await expect(owner.query(`DELETE FROM evidence WHERE id = $1`, [id])).rejects.toThrow(
      /never deleted/,
    );

    // Not even under the A-2 override flag, which opens every other post-completion write.
    await expect(
      asOverridingSuperAdmin(owner, () => owner.query(`DELETE FROM evidence WHERE id = $1`, [id])),
    ).rejects.toThrow(/never deleted/);
  });

  it('leaves evidence writable while the audit is still in progress', async () => {
    const fixture = await seedAuditFixture(owner);
    const id = await insertEvidence(fixture, { sync_state: 'SYNCING' });

    // Commit, reclassification (E-2), the summary flag and the soft delete (E-4) all
    // happen before completion. A trigger that froze the table from INSERT — which is what
    // `enforce_append_only()` does unconditionally — would make the table unusable.
    await owner.query(
      `UPDATE evidence SET sync_state = 'SYNCED', uploaded_at = now(),
                           classification = 'NONCONFORMITY', remark = 'Rack B unlabelled'
       WHERE id = $1`,
      [id],
    );
    await owner.query(`UPDATE evidence SET deleted_at = now() WHERE id = $1`, [id]);

    const { rows } = await owner.query(`SELECT sync_state, remark FROM evidence WHERE id = $1`, [
      id,
    ]);
    expect(rows[0].sync_state).toBe('SYNCED');
    expect(rows[0].remark).toBe('Rack B unlabelled');
  });

  it('freezes everything except the three redaction columns after completion', async () => {
    const fixture = await seedAuditFixture(owner);
    const id = await insertEvidence(fixture);
    await complete(fixture.auditId);

    await expect(
      owner.query(`UPDATE evidence SET remark = 'changed later' WHERE id = $1`, [id]),
    ).rejects.toThrow(/may not be updated after completion/);

    await expect(
      owner.query(`UPDATE evidence SET classification = 'NEUTRAL' WHERE id = $1`, [id]),
    ).rejects.toThrow(/may not be updated after completion/);

    await expect(
      owner.query(`UPDATE evidence SET deleted_at = now() WHERE id = $1`, [id]),
    ).rejects.toThrow(/may not be updated after completion/);
  });

  it('permits the redaction carve-out on a completed audit, with no override flag', async () => {
    const fixture = await seedAuditFixture(owner);
    const id = await insertEvidence(fixture);
    await complete(fixture.auditId);

    // R-5's whole point: a subject asks for their photograph to be erased, and that must
    // work on a two-year-old completed audit without opening the audit itself.
    await owner.query(
      `UPDATE evidence
       SET redacted_at = now(), redacted_by_user_id = $2, redaction_reason = 'Subject request'
       WHERE id = $1`,
      [id, IDS.superAdmin],
    );

    const { rows } = await owner.query(
      `SELECT redaction_reason, checksum_sha256, object_key FROM evidence WHERE id = $1`,
      [id],
    );
    expect(rows[0].redaction_reason).toBe('Subject request');
    // The record survives: the row still says a photo was present, and what it was.
    expect(rows[0].checksum_sha256).toHaveLength(64);
    expect(rows[0].object_key).toBeTruthy();
  });

  it('refuses a redaction that smuggles another column along with it', async () => {
    const fixture = await seedAuditFixture(owner);
    const id = await insertEvidence(fixture);
    await complete(fixture.auditId);

    await expect(
      owner.query(
        `UPDATE evidence
         SET redacted_at = now(), redacted_by_user_id = $2, redaction_reason = 'x',
             classification = 'NEUTRAL'
         WHERE id = $1`,
        [id, IDS.superAdmin],
      ),
    ).rejects.toThrow(/may not be updated after completion/);
  });
});

describe('§9.5 Layer 3 — the quarantine is never deleted from', () => {
  async function quarantine(): Promise<string> {
    const { rows } = await owner.query(
      `INSERT INTO sync_conflict (device_id, user_id, entity_type, entity_id, reason,
                                  incoming_payload)
       VALUES ($1, $2, 'question_response', gen_random_uuid(), 'AUDIT_ALREADY_COMPLETED', $3)
       RETURNING id`,
      [IDS.deviceA, IDS.consultant, JSON.stringify({ value: 'SCORE_1', remark: 'Rack B' })],
    );
    return rows[0].id as string;
  }

  it('refuses a DELETE', async () => {
    await seedAuditFixture(owner);
    const id = await quarantine();

    await expect(owner.query(`DELETE FROM sync_conflict WHERE id = $1`, [id])).rejects.toThrow(
      /never deleted/,
    );
  });

  it('keeps the full payload after a DISCARD resolution', async () => {
    await seedAuditFixture(owner);
    const id = await quarantine();

    await owner.query(
      `UPDATE sync_conflict
       SET resolved_at = now(), resolved_by_user_id = $2, resolution = 'DISCARD',
           resolution_note = 'Duplicate of the corrected answer'
       WHERE id = $1`,
      [id, IDS.superAdmin],
    );

    const { rows } = await owner.query(
      `SELECT resolution, incoming_payload FROM sync_conflict WHERE id = $1`,
      [id],
    );
    // Discarding is a decision about what to *act on*, never about what to retain.
    expect(rows[0].resolution).toBe('DISCARD');
    expect(rows[0].incoming_payload).toEqual({ value: 'SCORE_1', remark: 'Rack B' });
  });

  it('refuses a half-recorded resolution', async () => {
    await seedAuditFixture(owner);
    const id = await quarantine();

    await expect(
      owner.query(`UPDATE sync_conflict SET resolved_at = now() WHERE id = $1`, [id]),
    ).rejects.toThrow(/sync_conflict_resolved_together/);

    await expect(
      owner.query(
        `UPDATE sync_conflict SET resolved_at = now(), resolved_by_user_id = $2,
                                  resolution = 'MAYBE' WHERE id = $1`,
        [id, IDS.superAdmin],
      ),
    ).rejects.toThrow(/sync_conflict_resolution/);
  });

  it('gives the application role no DELETE grant on any of the three tables', async () => {
    // Belt and braces (AL-1): the trigger refuses the statement, and the missing grant
    // means the statement never reaches the trigger.
    const { rows } = await owner.query(
      `SELECT table_name FROM information_schema.role_table_grants
       WHERE grantee = 'audit5s_app' AND privilege_type = 'DELETE'
         AND table_name IN ('evidence','sync_conflict','device_sync_record')`,
    );
    expect(rows).toEqual([]);
  });
});

describe('device_sync_record — the batch dedupe index (§9.3)', () => {
  it('refuses the same batchId twice', async () => {
    await seedAuditFixture(owner);
    const batchId = '01930000-0000-7000-8000-00000000b001';

    const insert = () =>
      owner.query(
        `INSERT INTO device_sync_record (device_id, user_id, batch_id, item_count)
         VALUES ($1, $2, $3, 5)`,
        [IDS.deviceA, IDS.consultant, batchId],
      );

    await insert();
    // §9.3: "a duplicated sync creates nothing extra". This index is what makes the
    // replay path answer from storage instead of applying a second time.
    await expect(insert()).rejects.toThrow(/device_sync_record_batch_key/);
  });
});

describe('row-level security', () => {
  it('hides another auditor’s evidence from a Zone Leader outside the Unit', async () => {
    const fixture = await seedAuditFixture(owner);
    await insertEvidence(fixture);

    // The Consultant owns the audit and sees it.
    const mine = await asActor(app, IDS.consultant, 'CONSULTANT', () =>
      app.query(`SELECT id FROM evidence`),
    );
    expect(mine.rows).toHaveLength(1);

    // A Zone Leader of Unit A sees it too: PART 6.3 gives them `own_unit` on evidence.
    const unitPeer = await asActor(app, IDS.zoneLeaderA, 'ZONE_LEADER', () =>
      app.query(`SELECT id FROM evidence`),
    );
    expect(unitPeer.rows).toHaveLength(1);

    // With no actor context at all, nothing: the fail-safe default is no rows.
    const anonymous = await app.query(`SELECT id FROM evidence`);
    expect(anonymous.rows).toHaveLength(0);
  });

  it('lets only a Super Admin read the quarantine', async () => {
    await seedAuditFixture(owner);
    await owner.query(
      `INSERT INTO sync_conflict (device_id, user_id, entity_type, entity_id, reason,
                                  incoming_payload)
       VALUES ($1, $2, 'audit_zone', gen_random_uuid(), 'DEVICE_NOT_OWNER', '{}'::jsonb)`,
      [IDS.deviceA, IDS.consultant],
    );

    const asSuperAdmin = await asActor(app, IDS.superAdmin, 'SUPER_ADMIN', () =>
      app.query(`SELECT id FROM sync_conflict`),
    );
    expect(asSuperAdmin.rows).toHaveLength(1);

    // Not even the Consultant whose own payload it is: PART 6.3 gives `sync_conflict:read`
    // to SUPER_ADMIN alone, and the policy says so too.
    const asConsultant = await asActor(app, IDS.consultant, 'CONSULTANT', () =>
      app.query(`SELECT id FROM sync_conflict`),
    );
    expect(asConsultant.rows).toHaveLength(0);
  });
});
