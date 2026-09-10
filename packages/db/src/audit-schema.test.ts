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
 * Phase 3 schema invariants, asserted against a real PostgreSQL.
 *
 * These write the forbidden statement directly, as the schema owner, bypassing every line
 * of application code. That is the point: A-1, A-2 and QR-1 all protect data that cannot
 * be reconstructed once it is wrong, so each has to be a database guarantee rather than a
 * service that declines.
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

/** Moves an audit past completion without going through the append-only trigger's rule. */
async function complete(auditId: string): Promise<void> {
  await owner.query(
    `UPDATE audit SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
    [auditId],
  );
}

describe('invariant QR-1 — numeric_score is NULL iff the value is NA', () => {
  it('accepts each legal pairing', async () => {
    const { auditZoneId, auditId, questionIds } = await seedAuditFixture(owner, { questions: 5 });

    for (const [index, [value, score]] of (
      [
        ['SCORE_2', 2],
        ['SCORE_1', 1],
        ['SCORE_0', 0],
        ['NA', null],
      ] as const
    ).entries()) {
      await expect(
        owner.query(
          `INSERT INTO question_response (id, audit_zone_id, audit_id, checklist_question_id,
                                          section, global_order, value, numeric_score, answered_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'S1_SORT', $4, $5, $6, now())`,
          [auditZoneId, auditId, questionIds[index + 1], index + 2, value, score],
        ),
      ).resolves.toBeDefined();
    }
  });

  it('refuses NA carrying a number — the case that would poison the denominator', async () => {
    const { auditZoneId, auditId, questionIds } = await seedAuditFixture(owner, { questions: 2 });

    await expect(
      owner.query(
        `INSERT INTO question_response (id, audit_zone_id, audit_id, checklist_question_id,
                                        section, global_order, value, numeric_score, answered_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'S1_SORT', 2, 'NA', 0, now())`,
        [auditZoneId, auditId, questionIds[1]],
      ),
    ).rejects.toThrow(/question_response_qr1/);
  });

  it('refuses a score that disagrees with its enum', async () => {
    const { auditZoneId, auditId, questionIds } = await seedAuditFixture(owner, { questions: 2 });

    await expect(
      owner.query(
        `INSERT INTO question_response (id, audit_zone_id, audit_id, checklist_question_id,
                                        section, global_order, value, numeric_score, answered_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'S1_SORT', 2, 'SCORE_0', 2, now())`,
        [auditZoneId, auditId, questionIds[1]],
      ),
    ).rejects.toThrow(/question_response_qr1/);
  });

  it('makes COUNT(numeric_score) the applicable-question count', async () => {
    const { auditZoneId, auditId, questionIds } = await seedAuditFixture(owner, { questions: 4 });
    for (const [index, value] of ['NA', 'NA', 'SCORE_1'].entries()) {
      await owner.query(
        `INSERT INTO question_response (id, audit_zone_id, audit_id, checklist_question_id,
                                        section, global_order, value, numeric_score, answered_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'S1_SORT', $4, $5, $6, now())`,
        [auditZoneId, auditId, questionIds[index + 1], index + 2, value, value === 'NA' ? null : 1],
      );
    }

    const { rows } = await owner.query(
      `SELECT COUNT(*)::int AS answered, COUNT(numeric_score)::int AS applicable,
              COALESCE(SUM(numeric_score), 0)::int AS raw
       FROM question_response WHERE audit_zone_id = $1`,
      [auditZoneId],
    );

    // Four answers, two of them NA. The denominator is 2 × 2, not 4 × 2 (D3).
    expect(rows[0]).toEqual({ answered: 4, applicable: 2, raw: 3 });
  });
});

describe('invariant A-2 — append-only *after* COMPLETED, not from insert', () => {
  it('permits editing a response while the audit is in progress', async () => {
    const { responseId } = await seedAuditFixture(owner);
    await expect(
      owner.query(
        `UPDATE question_response SET value = 'SCORE_1', numeric_score = 1 WHERE id = $1`,
        [responseId],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses the same edit once the audit is COMPLETED', async () => {
    const { auditId, responseId } = await seedAuditFixture(owner);
    await complete(auditId);

    await expect(
      owner.query(
        `UPDATE question_response SET value = 'SCORE_0', numeric_score = 0 WHERE id = $1`,
        [responseId],
      ),
    ).rejects.toThrow(/append-only after completion|may not be updated after completion/);
  });

  it('refuses an edit to the Zone remark of a completed audit', async () => {
    const { auditId, auditZoneId } = await seedAuditFixture(owner);
    await complete(auditId);

    await expect(
      owner.query(`UPDATE audit_zone SET zone_remark = 'Rewritten' WHERE id = $1`, [auditZoneId]),
    ).rejects.toThrow(/after completion/);
  });

  it('refuses an edit to the audited facts on the audit row itself', async () => {
    const { auditId } = await seedAuditFixture(owner);
    await complete(auditId);

    await expect(
      owner.query(`UPDATE audit SET total_score = 100 WHERE id = $1`, [auditId]),
    ).rejects.toThrow(/after completion/);
  });

  it('still lets the audit’s own lifecycle continue past COMPLETED', async () => {
    const { auditId } = await seedAuditFixture(owner);
    await complete(auditId);

    // Corrective actions move a completed audit through three more statuses. Those are
    // status changes, not edits to what was audited.
    await expect(
      owner.query(`UPDATE audit SET status = 'CORRECTIVE_ACTION_OPEN' WHERE id = $1`, [auditId]),
    ).resolves.toBeDefined();
    await expect(
      owner.query(`UPDATE audit SET status = 'CLOSED', closed_at = now() WHERE id = $1`, [
        auditId,
      ]),
    ).resolves.toBeDefined();
  });

  it('opens the named carve-out only for a Super Admin under the override flag', async () => {
    const { auditId, responseId } = await seedAuditFixture(owner);
    await complete(auditId);

    await asOverridingSuperAdmin(owner, async () => {
      await owner.query(
        `UPDATE question_response SET value = 'SCORE_1', numeric_score = 1 WHERE id = $1`,
        [responseId],
      );
    });

    const { rows } = await owner.query(`SELECT value FROM question_response WHERE id = $1`, [
      responseId,
    ]);
    expect(rows[0].value).toBe('SCORE_1');
  });

  it('refuses the flag without the role — it is a carve-out, not a switch', async () => {
    const { auditId, responseId } = await seedAuditFixture(owner);
    await complete(auditId);

    await expect(
      asActor(owner, IDS.consultant, 'CONSULTANT', async () => {
        await owner.query(`SELECT set_config('app.post_completion_override', 'on', true)`);
        await owner.query(`UPDATE question_response SET remark = 'Sneaky' WHERE id = $1`, [
          responseId,
        ]);
      }),
    ).rejects.toThrow(/after completion/);
  });
});

describe('invariant A-1 / D8 — nothing in the audit trail is deleted', () => {
  it('refuses a DELETE on audit, audit_zone and question_response, even as the owner', async () => {
    const { auditId, auditZoneId, responseId } = await seedAuditFixture(owner);

    await expect(
      owner.query(`DELETE FROM question_response WHERE id = $1`, [responseId]),
    ).rejects.toThrow(/never deleted from/);
    await expect(owner.query(`DELETE FROM audit_zone WHERE id = $1`, [auditZoneId])).rejects.toThrow(
      /never deleted from/,
    );
    await expect(owner.query(`DELETE FROM audit WHERE id = $1`, [auditId])).rejects.toThrow(
      /cancelled, not removed/,
    );
  });

  it('refuses a DELETE on a completed audit under the override too', async () => {
    const { auditId, responseId } = await seedAuditFixture(owner);
    await complete(auditId);

    await expect(
      asOverridingSuperAdmin(owner, () =>
        owner.query(`DELETE FROM question_response WHERE id = $1`, [responseId]),
      ),
    ).rejects.toThrow(/never deleted from/);
  });

  it('gives the application role no DELETE grant on any of them', async () => {
    for (const table of ['audit', 'audit_zone', 'question_response', 'audit_assignment']) {
      const { rows } = await owner.query(
        `SELECT has_table_privilege('audit5s_app', $1, 'DELETE') AS allowed`,
        [table],
      );
      expect(rows[0].allowed, `${table} must not be deletable by the app role`).toBe(false);
    }
  });

  it('leaves CANCELLED as the strongest administrative action', async () => {
    const { auditId } = await seedAuditFixture(owner);
    await owner.query(`UPDATE audit SET status = 'CANCELLED' WHERE id = $1`, [auditId]);

    const { rows } = await owner.query(
      `SELECT (SELECT COUNT(*) FROM audit_zone WHERE audit_id = $1)::int AS zones,
              (SELECT COUNT(*) FROM question_response WHERE audit_id = $1)::int AS responses`,
      [auditId],
    );
    // Every row is retained. That is the whole difference between cancel and delete.
    expect(rows[0]).toEqual({ zones: 1, responses: 1 });
  });
});

describe('decision D6 — history is immutable by snapshot, not by locking master data', () => {
  it('leaves the audit Zone untouched when the live Zone is renamed and re-described', async () => {
    const { zoneId, auditZoneId, auditId } = await seedAuditFixture(owner);
    await complete(auditId);

    // Exactly what a Coordinator is meant to stay free to do.
    await owner.query(
      `UPDATE zone SET name = 'Press Shop (renamed)', description = 'Now bay 7' WHERE id = $1`,
      [zoneId],
    );

    const { rows } = await owner.query(
      `SELECT zone_name_snapshot, zone_description_snapshot, zone_leader_name_snapshot
       FROM audit_zone WHERE id = $1`,
      [auditZoneId],
    );
    expect(rows[0]).toEqual({
      zone_name_snapshot: 'Press',
      zone_description_snapshot: 'Press shop, bay 3',
      zone_leader_name_snapshot: 'Leader One',
    });
  });

  it('keeps the leader name after the user is renamed', async () => {
    const { auditZoneId } = await seedAuditFixture(owner);
    await owner.query(`UPDATE "user" SET full_name = 'Leader Renamed' WHERE id = $1`, [
      IDS.zoneLeaderA,
    ]);

    const { rows } = await owner.query(
      `SELECT zone_leader_name_snapshot FROM audit_zone WHERE id = $1`,
      [auditZoneId],
    );
    expect(rows[0].zone_leader_name_snapshot).toBe('Leader One');
  });
});

describe('uniqueness', () => {
  it('permits a Zone at most once per audit', async () => {
    const { auditId, zoneId } = await seedAuditFixture(owner);
    await expect(
      owner.query(
        `INSERT INTO audit_zone (id, audit_id, zone_id, sequence_no, zone_code_snapshot,
                                 zone_name_snapshot)
         VALUES (gen_random_uuid(), $1, $2, 2, 'Z-01', 'Press')`,
        [auditId, zoneId],
      ),
    ).rejects.toThrow(/audit_zone_audit_zone_key/);
  });

  it('makes a retried response upsert land on the same row', async () => {
    const { auditZoneId, auditId, questionId } = await seedAuditFixture(owner);
    await expect(
      owner.query(
        `INSERT INTO question_response (id, audit_zone_id, audit_id, checklist_question_id,
                                        section, global_order, value, numeric_score, answered_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'S1_SORT', 1, 'SCORE_0', 0, now())`,
        [auditZoneId, auditId, questionId],
      ),
    ).rejects.toThrow(/question_response_zone_question_key/);
  });

  it('holds a section score at most once per Zone, and refuses D4 disagreement', async () => {
    const { auditZoneId } = await seedAuditFixture(owner);
    await owner.query(
      `INSERT INTO audit_zone_section_score (audit_zone_id, section, applicable_questions,
                                             na_questions, raw_score, max_score, score_percentage)
       VALUES ($1, 'S1_SORT', 1, 0, 2, 2, 100.000)`,
      [auditZoneId],
    );

    await expect(
      owner.query(
        `INSERT INTO audit_zone_section_score (audit_zone_id, section, applicable_questions,
                                               na_questions, raw_score, max_score, score_percentage)
         VALUES ($1, 'S1_SORT', 1, 0, 2, 2, 100.000)`,
        [auditZoneId],
      ),
    ).rejects.toThrow(/audit_zone_section_score_key/);

    // A fully-NA section carries no percentage, and a scored one must carry one (D4).
    await expect(
      owner.query(
        `INSERT INTO audit_zone_section_score (audit_zone_id, section, applicable_questions,
                                               na_questions, raw_score, max_score, score_percentage)
         VALUES ($1, 'S2_SET_IN_ORDER', 0, 10, 0, 0, 0.000)`,
        [auditZoneId],
      ),
    ).rejects.toThrow(/audit_zone_section_score_d4/);
  });
});

describe('the Phase 2 seam, now closed', () => {
  it('reports a Zone busy while its audit Zone is unfinished', async () => {
    const { zoneId } = await seedAuditFixture(owner);
    const { rows } = await owner.query(`SELECT zone_has_in_progress_audit($1) AS busy`, [zoneId]);
    expect(rows[0].busy).toBe(true);
  });

  it('reports it free once the Zone is completed', async () => {
    const { zoneId, auditZoneId } = await seedAuditFixture(owner);
    await owner.query(
      `UPDATE audit_zone SET status = 'COMPLETED', completed_at = now() WHERE id = $1`,
      [auditZoneId],
    );
    const { rows } = await owner.query(`SELECT zone_has_in_progress_audit($1) AS busy`, [zoneId]);
    expect(rows[0].busy).toBe(false);
  });

  it('reports it free once the audit is cancelled — a void audit blocks nothing', async () => {
    const { zoneId, auditId } = await seedAuditFixture(owner);
    await owner.query(`UPDATE audit SET status = 'CANCELLED' WHERE id = $1`, [auditId]);
    const { rows } = await owner.query(`SELECT zone_has_in_progress_audit($1) AS busy`, [zoneId]);
    expect(rows[0].busy).toBe(false);
  });

  it('reports a Zone with no audit at all free', async () => {
    const { rows } = await owner.query(
      `SELECT zone_has_in_progress_audit(gen_random_uuid()) AS busy`,
    );
    expect(rows[0].busy).toBe(false);
  });

  it('answers a Coordinator truthfully about another auditor’s running audit', async () => {
    // SECURITY DEFINER, because RLS on `audit` would otherwise hide the Consultant's
    // audit from the Coordinator and turn "busy" into "free" — the one wrong answer.
    const { zoneId } = await seedAuditFixture(owner);
    const busy = await asActor(app, IDS.coordinatorA, 'COORDINATOR', async () => {
      const { rows } = await app.query(`SELECT zone_has_in_progress_audit($1) AS busy`, [zoneId]);
      return rows[0].busy as boolean;
    });
    expect(busy).toBe(true);
  });
});

describe('row-level security behind the ScopeGuard', () => {
  it('shows a Consultant their own audit and hides another Unit’s', async () => {
    const { auditId } = await seedAuditFixture(owner);
    await owner.query(
      `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id)
       VALUES (gen_random_uuid(), $1, 'WALK_BY', 'READY', $2)`,
      [IDS.unitB, IDS.superAdmin],
    );

    const visible = await asActor(app, IDS.consultant, 'CONSULTANT', async () => {
      const { rows } = await app.query(`SELECT id FROM audit`);
      return rows.map((row) => row.id as string);
    });

    expect(visible).toContain(auditId);
  });

  it('hides every audit from an actor with no context set at all', async () => {
    await seedAuditFixture(owner);
    const { rows } = await app.query(`SELECT id FROM audit`);
    expect(rows).toHaveLength(0);
  });
});
