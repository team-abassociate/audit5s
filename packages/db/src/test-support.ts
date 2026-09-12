import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Connection strings for the schema tests. These run against a real PostgreSQL — the
 * constraints under test *are* database constraints, so a mock would assert nothing.
 */
export const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgres://audit5s_owner:audit5s_owner@127.0.0.1:5432/audit5s';

export const APP_URL =
  process.env.DATABASE_URL ?? 'postgres://audit5s_app:audit5s_app@127.0.0.1:5432/audit5s';

export async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Applies every pending migration. Safe to call repeatedly. */
export function migrate(): void {
  execFileSync('npx', ['tsx', join(__dirname, 'migrate.ts')], {
    env: { ...process.env, DATABASE_MIGRATION_URL: OWNER_URL },
    stdio: 'pipe',
  });
}

/**
 * Clears business rows between tests.
 *
 * TRUNCATE, not DELETE: the append-only triggers exist precisely to refuse a row DELETE,
 * and TRUNCATE does not fire row-level triggers. That is safe here and not a hole in
 * AL-1, because TRUNCATE is an owner-only privilege — the application role has no grant
 * for it, which `schema.test.ts` asserts directly.
 */
export async function resetFixtures(owner: Client): Promise<void> {
  await owner.query(`
    TRUNCATE metric_section_daily, metric_daily_zone, metric_daily_unit,
             notification_delivery, notification, notification_preference,
             corrective_action_submission, corrective_action,
             evidence, sync_conflict, device_sync_record,
             question_response, audit_zone_section_score, audit_zone, audit,
             audit_assignment,
             checklist_import_row, checklist_import_sheet, checklist_import_job,
             checklist_question, checklist_version, checklist_template, zone,
             audit_log, login_attempt, idempotency_key, revoked_access_token,
             refresh_token, otp_challenge, device, unit_membership, unit, "user"
    RESTART IDENTITY CASCADE;
  `);
}

export const IDS = {
  superAdmin: '11111111-1111-1111-1111-111111111111',
  coordinatorA: '22222222-2222-2222-2222-222222222222',
  consultant: '33333333-3333-3333-3333-333333333333',
  zoneLeaderA: '44444444-4444-4444-4444-444444444444',
  unitA: 'aaaaaaaa-0000-0000-0000-000000000001',
  unitB: 'aaaaaaaa-0000-0000-0000-000000000002',
  templateA: 'bbbbbbbb-0000-0000-0000-000000000001',
  zoneA: 'cccccccc-0000-0000-0000-000000000001',
  deviceA: 'dddddddd-0000-0000-0000-000000000001',
  auditA: 'eeeeeeee-0000-0000-0000-000000000001',
  auditZoneA: 'ffffffff-0000-0000-0000-000000000001',
} as const;

/** Two Units, one user per role, the Consultant assigned to both Units. */
export async function seedFixtures(owner: Client): Promise<void> {
  await owner.query(
    `INSERT INTO "user" (id, login_id, full_name, phone_e164, role, password_hash, status)
     VALUES ($1,'SA0001','Super Admin','+919000000001','SUPER_ADMIN','x','ACTIVE'),
            ($2,'CO0002','Coord One','+919000000002','COORDINATOR','x','ACTIVE'),
            ($3,'CN0003','Consult One','+919000000003','CONSULTANT','x','ACTIVE'),
            ($4,'ZL0004','Leader One','+919000000004','ZONE_LEADER','x','ACTIVE')`,
    [IDS.superAdmin, IDS.coordinatorA, IDS.consultant, IDS.zoneLeaderA],
  );
  await owner.query(
    `INSERT INTO unit (id, name) VALUES ($1,'Unit A'), ($2,'Unit B')`,
    [IDS.unitA, IDS.unitB],
  );
  await owner.query(
    `INSERT INTO unit_membership (user_id, unit_id, role, assigned_by_user_id)
     VALUES ($1,$5,'COORDINATOR',$4),
            ($2,$5,'ZONE_LEADER',$4),
            ($3,$5,'CONSULTANT',$4),
            ($3,$6,'CONSULTANT',$4)`,
    [IDS.coordinatorA, IDS.zoneLeaderA, IDS.consultant, IDS.superAdmin, IDS.unitA, IDS.unitB],
  );
}

/** Runs `work` inside a transaction carrying the given actor context. */
export async function asActor<T>(
  client: Client,
  actorId: string | null,
  actorRole: string | null,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    if (actorId) {
      await client.query(`SELECT set_config('app.actor_id', $1, true)`, [actorId]);
    }
    if (actorRole) {
      await client.query(`SELECT set_config('app.actor_role', $1, true)`, [actorRole]);
    }
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * A checklist template with one DRAFT version and a single question.
 *
 * Deliberately minimal: these tests exercise the CV-1 trigger, not the importer, and a
 * full fifty-question version would only slow every case down without asserting more.
 */
export async function seedChecklistFixture(
  owner: Client,
  options: { code?: string; contentHash?: string } = {},
): Promise<{ templateId: string; versionId: string; questionId: string }> {
  const { rows: templateRows } = await owner.query(
    `INSERT INTO checklist_template (id, code, name, sort_order)
     VALUES ($1, $2, 'Premises', 0) RETURNING id`,
    [IDS.templateA, options.code ?? 'PREMISES'],
  );
  const templateId = templateRows[0].id as string;

  const { rows: versionRows } = await owner.query(
    `INSERT INTO checklist_version (template_id, version_number, total_questions, content_hash)
     VALUES ($1, 1, 50, $2) RETURNING id`,
    [templateId, options.contentHash ?? 'content-hash-v1'],
  );
  const versionId = versionRows[0].id as string;

  const { rows: questionRows } = await owner.query(
    `INSERT INTO checklist_question (version_id, section, order_in_section, global_order, text)
     VALUES ($1, 'S1_SORT', 1, 1, 'Only required items are present') RETURNING id`,
    [versionId],
  );

  return { templateId, versionId, questionId: questionRows[0].id as string };
}

export async function publish(owner: Client, versionId: string): Promise<void> {
  await owner.query(
    `UPDATE checklist_version SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
    [versionId],
  );
}

/**
 * A Zone in Unit A, a registered device, and an IN_PROGRESS audit over that Zone with one
 * answered question.
 *
 * Deliberately one question rather than fifty: these tests exercise the A-2 trigger, the
 * QR-1 CHECK and the D6 snapshots, none of which care how many rows there are, and fifty
 * would only slow every case down.
 */
export async function seedAuditFixture(
  owner: Client,
  options: { auditStatus?: string; zoneStatus?: string; questions?: number } = {},
): Promise<{
  zoneId: string;
  auditId: string;
  auditZoneId: string;
  responseId: string;
  questionId: string;
  /** Every question of the pinned version, in `global_order`. */
  questionIds: string[];
  versionId: string;
}> {
  const { versionId, questionId } = await seedChecklistFixture(owner);

  // Extra questions are added while the version is still a DRAFT: CV-1 refuses an INSERT
  // into a published one, which is exactly the guarantee it exists to give.
  const questionIds = [questionId];
  for (let order = 2; order <= (options.questions ?? 1); order += 1) {
    const { rows } = await owner.query(
      `INSERT INTO checklist_question (version_id, section, order_in_section, global_order, text)
       VALUES ($1, 'S1_SORT', $2, $2, $3) RETURNING id`,
      [versionId, order, `Question ${order}`],
    );
    questionIds.push(rows[0].id as string);
  }

  await publish(owner, versionId);

  await owner.query(
    `INSERT INTO zone (id, unit_id, code, name, description, zone_leader_id)
     VALUES ($1, $2, 'Z-01', 'Press', 'Press shop, bay 3', $3)`,
    [IDS.zoneA, IDS.unitA, IDS.zoneLeaderA],
  );

  await owner.query(
    `INSERT INTO device (id, user_id, platform, model, os_version, app_version)
     VALUES ($1, $2, 'android', 'Pixel', '15', '1.0.0')`,
    [IDS.deviceA, IDS.consultant],
  );

  await owner.query(
    `INSERT INTO audit (id, unit_id, audit_type, status, auditor_user_id, owning_device_id,
                        checklist_version_id, started_at)
     VALUES ($1, $2, 'EXTERNAL_5S', $3, $4, $5, $6, now())`,
    [
      IDS.auditA,
      IDS.unitA,
      options.auditStatus ?? 'IN_PROGRESS',
      IDS.consultant,
      IDS.deviceA,
      versionId,
    ],
  );

  await owner.query(
    `INSERT INTO audit_zone (id, audit_id, zone_id, sequence_no, status,
                             zone_code_snapshot, zone_name_snapshot, zone_description_snapshot,
                             zone_leader_user_id_snapshot, zone_leader_name_snapshot,
                             checklist_version_id, checklist_template_name_snapshot)
     VALUES ($1, $2, $3, 1, $4, 'Z-01', 'Press', 'Press shop, bay 3', $5, 'Leader One', $6,
             'Premises')`,
    [IDS.auditZoneA, IDS.auditA, IDS.zoneA, options.zoneStatus ?? 'IN_PROGRESS', IDS.zoneLeaderA, versionId],
  );

  const { rows } = await owner.query(
    `INSERT INTO question_response (id, audit_zone_id, audit_id, checklist_question_id,
                                    section, global_order, value, numeric_score, answered_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'S1_SORT', 1, 'SCORE_2', 2, now())
     RETURNING id`,
    [IDS.auditZoneA, IDS.auditA, questionId],
  );

  return {
    zoneId: IDS.zoneA,
    auditId: IDS.auditA,
    auditZoneId: IDS.auditZoneA,
    responseId: rows[0].id as string,
    questionId,
    questionIds,
    versionId,
  };
}

/** Runs `work` with the post-completion override flag set, as the A-2 carve-out requires. */
export async function asOverridingSuperAdmin<T>(
  client: Client,
  work: () => Promise<T>,
): Promise<T> {
  return asActor(client, IDS.superAdmin, 'SUPER_ADMIN', async () => {
    await client.query(`SELECT set_config('app.post_completion_override', 'on', true)`);
    return work();
  });
}
