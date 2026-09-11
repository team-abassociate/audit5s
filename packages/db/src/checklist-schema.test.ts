import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import {
  APP_URL,
  IDS,
  OWNER_URL,
  asActor,
  connect,
  migrate,
  publish,
  resetFixtures,
  seedChecklistFixture,
  seedFixtures,
} from './test-support';

/**
 * Phase 2 schema invariants, asserted against a real PostgreSQL.
 *
 * CV-1 is the one that matters most here. "A published checklist may not change" has to
 * be a database guarantee rather than a service that declines, because it is what makes a
 * two-year-old audit still readable — so these tests write the forbidden statement
 * directly, bypassing every line of application code, and require the database to refuse.
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

describe('invariant CV-1 — a published version is immutable at the database', () => {
  it('permits editing a question while the version is still a DRAFT', async () => {
    const { versionId } = await seedChecklistFixture(owner);
    await expect(
      owner.query(`UPDATE checklist_question SET text = 'Reworded' WHERE version_id = $1`, [
        versionId,
      ]),
    ).resolves.toBeDefined();
  });

  it('refuses an UPDATE on a published question', async () => {
    const { versionId } = await seedChecklistFixture(owner);
    await publish(owner, versionId);

    await expect(
      owner.query(`UPDATE checklist_question SET text = 'Tampered' WHERE version_id = $1`, [
        versionId,
      ]),
    ).rejects.toThrow(/its questions are immutable \(CV-1\)/);
  });

  it('refuses a DELETE on a published question', async () => {
    const { versionId } = await seedChecklistFixture(owner);
    await publish(owner, versionId);

    await expect(
      owner.query(`DELETE FROM checklist_question WHERE version_id = $1`, [versionId]),
    ).rejects.toThrow(/its questions are immutable \(CV-1\)/);
  });

  it('refuses an INSERT of a new question into a published version', async () => {
    const { versionId } = await seedChecklistFixture(owner);
    await publish(owner, versionId);

    await expect(
      owner.query(
        `INSERT INTO checklist_question (version_id, section, order_in_section, global_order, text)
         VALUES ($1, 'S1_SORT', 2, 2, 'Appended after publication')`,
        [versionId],
      ),
    ).rejects.toThrow(/its questions are immutable \(CV-1\)/);
  });

  it('refuses an UPDATE to any column of a published version but the supersession three', async () => {
    const { versionId } = await seedChecklistFixture(owner);
    await publish(owner, versionId);

    await expect(
      owner.query(`UPDATE checklist_version SET total_questions = 40 WHERE id = $1`, [versionId]),
    ).rejects.toThrow(/column total_questions may not be updated \(CV-1\)/);

    await expect(
      owner.query(`UPDATE checklist_version SET content_hash = 'rewritten' WHERE id = $1`, [
        versionId,
      ]),
    ).rejects.toThrow(/column content_hash may not be updated \(CV-1\)/);
  });

  it('permits the supersession carve-out, which is how publishing v2 retires v1', async () => {
    const { versionId } = await seedChecklistFixture(owner);
    await publish(owner, versionId);

    await expect(
      owner.query(
        `UPDATE checklist_version SET status = 'SUPERSEDED', superseded_at = now() WHERE id = $1`,
        [versionId],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses to walk a published version back to DRAFT', async () => {
    const { versionId } = await seedChecklistFixture(owner);
    await publish(owner, versionId);

    await expect(
      owner.query(`UPDATE checklist_version SET status = 'DRAFT' WHERE id = $1`, [versionId]),
    ).rejects.toThrow(/may only move to SUPERSEDED or ARCHIVED/);
  });

  it('refuses to delete a version that has ever been published', async () => {
    const { versionId } = await seedChecklistFixture(owner);
    await publish(owner, versionId);

    await expect(
      owner.query(`DELETE FROM checklist_version WHERE id = $1`, [versionId]),
    ).rejects.toThrow(/never deleted \(CV-1\)/);
  });
});

describe('checklist version constraints (§5.4)', () => {
  it('permits at most one PUBLISHED version per template', async () => {
    const { templateId, versionId } = await seedChecklistFixture(owner);
    await publish(owner, versionId);

    await expect(
      owner.query(
        `INSERT INTO checklist_version (template_id, version_number, total_questions,
                                        content_hash, status)
         VALUES ($1, 2, 50, 'other-hash', 'PUBLISHED')`,
        [templateId],
      ),
    ).rejects.toThrow(/checklist_version_one_published/);
  });

  it('permits a second published version once the first is superseded', async () => {
    const { templateId, versionId } = await seedChecklistFixture(owner);
    await publish(owner, versionId);
    await owner.query(
      `UPDATE checklist_version SET status = 'SUPERSEDED', superseded_at = now() WHERE id = $1`,
      [versionId],
    );

    await expect(
      owner.query(
        `INSERT INTO checklist_version (template_id, version_number, total_questions,
                                        content_hash, status)
         VALUES ($1, 2, 50, 'other-hash', 'PUBLISHED')`,
        [templateId],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses the same content twice under one template (stage 4)', async () => {
    const { templateId } = await seedChecklistFixture(owner);
    await expect(
      owner.query(
        `INSERT INTO checklist_version (template_id, version_number, total_questions, content_hash)
         VALUES ($1, 2, 50, 'content-hash-v1')`,
        [templateId],
      ),
    ).rejects.toThrow(/checklist_version_content_key/);
  });

  it('refuses a total_questions that is not 5 × questions_per_section (CQ-1)', async () => {
    const { templateId } = await seedChecklistFixture(owner);
    await expect(
      owner.query(
        `INSERT INTO checklist_version (template_id, version_number, questions_per_section,
                                        total_questions, content_hash)
         VALUES ($1, 2, 10, 45, 'h45')`,
        [templateId],
      ),
    ).rejects.toThrow(/checklist_version_shape/);
  });

  it('refuses two questions at the same position in a section', async () => {
    const { versionId } = await seedChecklistFixture(owner);
    await expect(
      owner.query(
        `INSERT INTO checklist_question (version_id, section, order_in_section, global_order, text)
         VALUES ($1, 'S1_SORT', 1, 2, 'A clash')`,
        [versionId],
      ),
    ).rejects.toThrow(/checklist_question_position_key/);
  });
});

describe('invariant Z-1 — a Zone never moves between Units', () => {
  async function seedZone(): Promise<string> {
    const { rows } = await owner.query(
      `INSERT INTO zone (unit_id, code, name) VALUES ($1, 'Z-01', 'Press') RETURNING id`,
      [IDS.unitA],
    );
    return rows[0].id as string;
  }

  it('refuses to change unit_id', async () => {
    const zoneId = await seedZone();
    await expect(
      owner.query(`UPDATE zone SET unit_id = $2 WHERE id = $1`, [zoneId, IDS.unitB]),
    ).rejects.toThrow(/unit_id is immutable \(invariant Z-1\)/);
  });

  it('permits every other edit, because history is protected by the snapshot (D6)', async () => {
    const zoneId = await seedZone();
    await expect(
      owner.query(`UPDATE zone SET description = 'Trimming section' WHERE id = $1`, [zoneId]),
    ).resolves.toBeDefined();
  });

  it('scopes the code uniqueness to the Unit, not the organization', async () => {
    await seedZone();
    await expect(
      owner.query(`INSERT INTO zone (unit_id, code, name) VALUES ($1, 'Z-01', 'Other press')`, [
        IDS.unitB,
      ]),
    ).resolves.toBeDefined();
    await expect(
      owner.query(`INSERT INTO zone (unit_id, code, name) VALUES ($1, 'Z-01', 'Duplicate')`, [
        IDS.unitA,
      ]),
    ).rejects.toThrow(/zone_unit_code_key/);
  });
});

describe('row-level security for the app role', () => {
  beforeEach(async () => {
    await owner.query(
      `INSERT INTO zone (unit_id, code, name) VALUES ($1,'Z-01','Press A'), ($2,'Z-01','Press B')`,
      [IDS.unitA, IDS.unitB],
    );
    await seedChecklistFixture(owner);
  });

  it('shows a Coordinator only their own Unit’s Zones', async () => {
    const rows = await asActor(app, IDS.coordinatorA, 'COORDINATOR', async () => {
      const result = await app.query('SELECT unit_id FROM zone');
      return result.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].unit_id).toBe(IDS.unitA);
  });

  it('shows a connection that never set an actor nothing at all', async () => {
    const rows = await asActor(app, null, null, async () => (await app.query('SELECT id FROM zone')).rows);
    expect(rows).toEqual([]);
  });

  it('shows every authenticated role the whole checklist catalogue (D2)', async () => {
    for (const [id, role] of [
      [IDS.superAdmin, 'SUPER_ADMIN'],
      [IDS.consultant, 'CONSULTANT'],
      [IDS.coordinatorA, 'COORDINATOR'],
      [IDS.zoneLeaderA, 'ZONE_LEADER'],
    ] as const) {
      const rows = await asActor(app, id, role, async () =>
        (await app.query('SELECT id FROM checklist_template')).rows,
      );
      expect(rows, `${role} must see the catalogue`).toHaveLength(1);
    }
  });

  it('hides import jobs from everyone but a Super Admin', async () => {
    await owner.query(
      `INSERT INTO checklist_import_job (uploaded_by_user_id, file_name, file_object_key,
                                         file_checksum, file_byte_size)
       VALUES ($1, 'book.xlsx', 'import/x/book.xlsx', 'sum', 1024)`,
      [IDS.superAdmin],
    );

    const asSuperAdmin = await asActor(app, IDS.superAdmin, 'SUPER_ADMIN', async () =>
      (await app.query('SELECT id FROM checklist_import_job')).rows,
    );
    expect(asSuperAdmin).toHaveLength(1);

    const asCoordinator = await asActor(app, IDS.coordinatorA, 'COORDINATOR', async () =>
      (await app.query('SELECT id FROM checklist_import_job')).rows,
    );
    expect(asCoordinator).toEqual([]);
  });

  it('withholds DELETE on checklist tables from the app role', async () => {
    const { rows } = await owner.query(
      `SELECT has_table_privilege('audit5s_app', $1, 'DELETE') AS allowed`,
      ['checklist_version'],
    );
    expect(rows[0].allowed).toBe(false);
  });
});

describe('the Phase 3 seam for archiving a Zone mid-audit', () => {
  // Phase 3 replaced the placeholder body with the real query; the cases that exercise it
  // against actual audit rows live in `audit-schema.test.ts`. What is asserted here is
  // the answer for a Zone that has no audit, which is the case the Zones module hits on
  // every archive of a Zone that was never audited.
  it('answers false for a Zone with no audit', async () => {
    const { rows } = await owner.query(
      `SELECT zone_has_in_progress_audit(gen_random_uuid()) AS busy`,
    );
    expect(rows[0].busy).toBe(false);
  });
});
