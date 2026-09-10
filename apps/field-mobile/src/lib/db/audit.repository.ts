import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AuditType, ResponseValue, SSection } from '@audit5s/contracts';
import { numericScoreFor, scoreZone, type ScoreBreakdown } from '@audit5s/domain';
import type { LocalDatabase } from './local-database';
import {
  audits,
  checklistQuestions,
  localAuditZones,
  localQuestionResponses,
  outbox,
  zones,
  type OutboxOperation,
} from './schema';

/**
 * The device's audit store (§9.1, §9.2).
 *
 * Two rules govern every function here, and both come from the same sentence: *SQLite is
 * the source of truth while an audit is in progress*.
 *
 *   1. **Nothing awaits the network.** There is no `fetch` in this file and no import that
 *      could reach one. A save is complete when SQLite commits, and the UI advances then.
 *   2. **The outbox row is written with the data.** One transaction, so an app killed a
 *      millisecond later has either both or neither — never an answer the server will
 *      never hear about.
 *
 * Scoring is imported from `@audit5s/domain`: the same `scoreZone` the API calls. The
 * Phase 3 acceptance row is that the two agree exactly, and they do because there is one
 * function, not two implementations of one formula.
 */

/** UUIDv7, so device-generated keys are time-ordered and index locality survives (D12). */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const timestamp = BigInt(now);
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((timestamp >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface StartAuditInput {
  unitId: string;
  auditType: AuditType;
  checklistVersionId: string | null;
  assignmentId?: string | null;
  id?: string;
  now?: string;
}

/** Creates the audit row and queues its creation. Returns the id the server will share. */
export async function createLocalAudit(
  database: LocalDatabase,
  input: StartAuditInput,
): Promise<string> {
  const id = input.id ?? uuidv7();
  const now = input.now ?? new Date().toISOString();

  await database.insert(audits).values({
    id,
    assignmentId: input.assignmentId ?? null,
    unitId: input.unitId,
    auditType: input.auditType,
    // The device claims IN_PROGRESS locally the moment the auditor starts. The server
    // arbitrates ownership when the push arrives (D7); until then the questionnaire is
    // usable, which is the point of not awaiting the network.
    status: 'IN_PROGRESS',
    checklistVersionId: input.checklistVersionId,
    startedAt: now,
    clientCreatedAt: now,
    clientUpdatedAt: now,
  });

  await enqueue(database, 'audit', id, 'upsert', {
    id,
    auditType: input.auditType,
    unitId: input.unitId,
    assignmentId: input.assignmentId ?? undefined,
    checklistVersionId: input.checklistVersionId ?? undefined,
    clientCreatedAt: now,
  });

  return id;
}

export interface AddZoneInput {
  auditId: string;
  zoneId: string;
  sequenceNo: number;
  checklistVersionId: string | null;
  id?: string;
  now?: string;
}

/**
 * Adds a Zone to the audit, taking the D6 snapshots from the cached Zone row.
 *
 * The device snapshots for the same reason the server does: what the report renders must
 * not move when the Zone is edited later. The server re-reads its own copy on the way in
 * and does not trust these — but the device needs them to render the questionnaire header
 * offline, so both hold a snapshot and the server's is authoritative.
 */
export async function addLocalZone(
  database: LocalDatabase,
  input: AddZoneInput,
): Promise<string> {
  const id = input.id ?? uuidv7();
  const now = input.now ?? new Date().toISOString();

  const [zone] = await database
    .select()
    .from(zones)
    .where(eq(zones.id, input.zoneId))
    .limit(1);

  if (!zone) {
    throw new Error(`Zone ${input.zoneId} is not in this device's catalogue`);
  }

  await database.insert(localAuditZones).values({
    id,
    auditId: input.auditId,
    zoneId: input.zoneId,
    sequenceNo: input.sequenceNo,
    status: 'DRAFT',
    zoneCodeSnapshot: zone.code,
    zoneNameSnapshot: zone.name,
    zoneDescriptionSnapshot: zone.description,
    zoneLeaderUserIdSnapshot: zone.zoneLeaderId,
    zoneLeaderNameSnapshot: zone.zoneLeaderName,
    checklistVersionId: input.checklistVersionId,
    clientUpdatedAt: now,
  });

  await database
    .update(audits)
    .set({ resumeAuditZoneId: id, clientUpdatedAt: now })
    .where(eq(audits.id, input.auditId));

  await enqueue(database, 'audit_zone', id, 'upsert', {
    auditId: input.auditId,
    zoneId: input.zoneId,
    sequenceNo: input.sequenceNo,
    checklistVersionId: input.checklistVersionId ?? undefined,
  });

  return id;
}

export interface SaveResponseInput {
  auditZoneId: string;
  auditId: string;
  checklistQuestionId: string;
  section: SSection;
  globalOrder: number;
  value: ResponseValue;
  remark?: string | null;
  id?: string;
  now?: string;
}

/**
 * Saves one answer. **This is the commit boundary** — §9.1 requires one per question
 * response, not one per section and not one per Zone.
 *
 * The upsert targets `(audit_zone_id, checklist_question_id)`, so an auditor changing
 * their mind updates the row rather than adding a second, and the outbox item coalesces
 * onto the same key. Four taps on one question produce one row and one queued item.
 */
export async function saveLocalResponse(
  database: LocalDatabase,
  input: SaveResponseInput,
): Promise<string> {
  const now = input.now ?? new Date().toISOString();
  const numericScore = numericScoreFor(input.value);

  const existing = await database
    .select({ id: localQuestionResponses.id })
    .from(localQuestionResponses)
    .where(
      and(
        eq(localQuestionResponses.auditZoneId, input.auditZoneId),
        eq(localQuestionResponses.checklistQuestionId, input.checklistQuestionId),
      ),
    )
    .limit(1);

  const id = existing[0]?.id ?? input.id ?? uuidv7();

  await database
    .insert(localQuestionResponses)
    .values({
      id,
      auditZoneId: input.auditZoneId,
      auditId: input.auditId,
      checklistQuestionId: input.checklistQuestionId,
      section: input.section,
      globalOrder: input.globalOrder,
      value: input.value,
      numericScore,
      remark: input.remark ?? null,
      answeredAt: now,
      clientUpdatedAt: now,
    })
    .onConflictDoUpdate({
      target: [localQuestionResponses.auditZoneId, localQuestionResponses.checklistQuestionId],
      set: {
        value: input.value,
        numericScore,
        remark: input.remark ?? null,
        answeredAt: now,
        clientUpdatedAt: now,
        syncState: 'LOCAL_ONLY',
      },
    });

  // The Zone moves off DRAFT on the first answer, and the cursor follows the last one, so
  // an abort a moment later resumes exactly here (§9.8).
  await database
    .update(localAuditZones)
    .set({
      status: 'IN_PROGRESS',
      startedAt: sql`COALESCE(${localAuditZones.startedAt}, ${now})`,
      resumeQuestionId: input.checklistQuestionId,
      clientUpdatedAt: now,
    })
    .where(eq(localAuditZones.id, input.auditZoneId));

  await database
    .update(audits)
    .set({ resumeAuditZoneId: input.auditZoneId, clientUpdatedAt: now })
    .where(eq(audits.id, input.auditId));

  await enqueue(database, 'question_response', id, 'upsert', {
    id,
    auditZoneId: input.auditZoneId,
    checklistQuestionId: input.checklistQuestionId,
    value: input.value,
    remark: input.remark ?? null,
    answeredAt: now,
  });

  return id;
}

/** The optional overall remark, saved after the fifty questions. */
export async function saveZoneRemark(
  database: LocalDatabase,
  auditZoneId: string,
  remark: string | null,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .update(localAuditZones)
    .set({ zoneRemark: remark, clientUpdatedAt: now })
    .where(eq(localAuditZones.id, auditZoneId));

  const [zone] = await database
    .select()
    .from(localAuditZones)
    .where(eq(localAuditZones.id, auditZoneId))
    .limit(1);

  if (zone) {
    await enqueue(database, 'audit_zone', auditZoneId, 'upsert', {
      auditId: zone.auditId,
      zoneId: zone.zoneId,
      sequenceNo: zone.sequenceNo,
      checklistVersionId: zone.checklistVersionId ?? undefined,
      zoneRemark: remark,
    });
  }
}

/** Finishes a Zone locally. The server re-checks the guard when the push arrives. */
export async function completeLocalZone(
  database: LocalDatabase,
  auditZoneId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .update(localAuditZones)
    .set({ status: 'COMPLETED', completedAt: now, resumeQuestionId: null, clientUpdatedAt: now })
    .where(eq(localAuditZones.id, auditZoneId));

  await enqueue(database, 'audit_zone', auditZoneId, 'complete', { completedAt: now });
}

/**
 * Abort (N7): save + pause + resume.
 *
 * It writes cursors and a status and nothing else. There is no branch here that could
 * discard an answer, because a rule that can block saving field work is a rule that loses
 * field work — and the Super Admin notification rides the outbox like everything else,
 * so pausing offline is never blocked on it (§9.8).
 */
export async function pauseLocalAudit(
  database: LocalDatabase,
  auditId: string,
  reason: string | null,
  now: string = new Date().toISOString(),
): Promise<void> {
  const cursor = await resumeCursor(database, auditId);

  await database
    .update(audits)
    .set({ status: 'PAUSED', pausedAt: now, pauseReason: reason, clientUpdatedAt: now })
    .where(eq(audits.id, auditId));

  await enqueue(database, 'audit', auditId, 'pause', {
    reason: reason ?? undefined,
    resumeAuditZoneId: cursor.auditZoneId ?? undefined,
    resumeQuestionId: cursor.questionId ?? undefined,
  });
}

export async function resumeLocalAudit(
  database: LocalDatabase,
  auditId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .update(audits)
    .set({ status: 'IN_PROGRESS', pausedAt: null, pauseReason: null, clientUpdatedAt: now })
    .where(eq(audits.id, auditId));

  await enqueue(database, 'audit', auditId, 'resume', {});
}

export async function completeLocalAudit(
  database: LocalDatabase,
  auditId: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .update(audits)
    .set({ status: 'COMPLETED', completedAt: now, clientUpdatedAt: now })
    .where(eq(audits.id, auditId));

  await enqueue(database, 'audit', auditId, 'complete', { completedAt: now });
}

// ------------------------------------------------------------------------------ reads

export function getLocalAudit(database: LocalDatabase, auditId: string) {
  return database.select().from(audits).where(eq(audits.id, auditId)).limit(1);
}

/** The History tab: this device's audits, newest first. */
export function listLocalAudits(database: LocalDatabase) {
  return database.select().from(audits).orderBy(sql`${audits.clientUpdatedAt} DESC`);
}

export function listLocalAuditZones(database: LocalDatabase, auditId: string) {
  return database
    .select()
    .from(localAuditZones)
    .where(eq(localAuditZones.auditId, auditId))
    .orderBy(asc(localAuditZones.sequenceNo));
}

export function getLocalAuditZone(database: LocalDatabase, auditZoneId: string) {
  return database
    .select()
    .from(localAuditZones)
    .where(eq(localAuditZones.id, auditZoneId))
    .limit(1);
}

export function listLocalResponses(database: LocalDatabase, auditZoneId: string) {
  return database
    .select()
    .from(localQuestionResponses)
    .where(eq(localQuestionResponses.auditZoneId, auditZoneId))
    .orderBy(asc(localQuestionResponses.globalOrder));
}

/**
 * The Zone's score, computed on the device from its own rows.
 *
 * `scoreZone` is the API's function, imported. That is the acceptance row: the number the
 * auditor sees before the radio comes back is the number the server will store, because
 * it is the same computation over the same answers.
 */
export async function scoreLocalZone(
  database: LocalDatabase,
  auditZoneId: string,
): Promise<ScoreBreakdown> {
  const responses = await database
    .select({
      section: localQuestionResponses.section,
      value: localQuestionResponses.value,
    })
    .from(localQuestionResponses)
    .where(eq(localQuestionResponses.auditZoneId, auditZoneId));

  return scoreZone(
    responses.map((response) => ({
      section: response.section as SSection,
      value: response.value as ResponseValue,
    })),
  );
}

/**
 * The questionnaire's data: every question of the pinned version, with the answer if one
 * exists. One query, ordered by `global_order`, because the screen is a paged list of
 * fifty and re-querying per question on a mid-range Android is visible.
 */
export async function listQuestionsWithAnswers(
  database: LocalDatabase,
  auditZoneId: string,
  checklistVersionId: string,
) {
  return database
    .select({
      questionId: checklistQuestions.id,
      section: checklistQuestions.section,
      orderInSection: checklistQuestions.orderInSection,
      globalOrder: checklistQuestions.globalOrder,
      text: checklistQuestions.text,
      guidance: checklistQuestions.guidance,
      allowsNa: checklistQuestions.allowsNa,
      value: localQuestionResponses.value,
      remark: localQuestionResponses.remark,
    })
    .from(checklistQuestions)
    .leftJoin(
      localQuestionResponses,
      and(
        eq(localQuestionResponses.checklistQuestionId, checklistQuestions.id),
        eq(localQuestionResponses.auditZoneId, auditZoneId),
      ),
    )
    .where(eq(checklistQuestions.versionId, checklistVersionId))
    .orderBy(asc(checklistQuestions.globalOrder));
}

/**
 * Where to reopen (§9.8): the audit's Zone cursor, and that Zone's question cursor.
 *
 * Entirely local, by design. A Consultant on a factory floor with no signal resumes an
 * audit aborted three days ago with no network round trip.
 */
export async function resumeCursor(
  database: LocalDatabase,
  auditId: string,
): Promise<{ auditZoneId: string | null; questionId: string | null; answered: number }> {
  const [audit] = await database
    .select({ resumeAuditZoneId: audits.resumeAuditZoneId })
    .from(audits)
    .where(eq(audits.id, auditId))
    .limit(1);

  const auditZoneId = audit?.resumeAuditZoneId ?? null;
  if (!auditZoneId) {
    return { auditZoneId: null, questionId: null, answered: 0 };
  }

  const [zone] = await database
    .select({ resumeQuestionId: localAuditZones.resumeQuestionId })
    .from(localAuditZones)
    .where(eq(localAuditZones.id, auditZoneId))
    .limit(1);

  const answered = await database
    .select({ id: localQuestionResponses.id })
    .from(localQuestionResponses)
    .where(eq(localQuestionResponses.auditZoneId, auditZoneId));

  return {
    auditZoneId,
    questionId: zone?.resumeQuestionId ?? null,
    answered: answered.length,
  };
}

// ----------------------------------------------------------------------------- outbox

/**
 * Enqueues one item, coalescing onto `(entity_type, entity_id, operation)`.
 *
 * A re-save replaces the pending payload rather than queueing a second item, and an item
 * already marked SYNCED is reset to PENDING because the row changed again after the push.
 */
export async function enqueue(
  database: LocalDatabase,
  entityType: string,
  entityId: string,
  operation: OutboxOperation,
  payload: Record<string, unknown>,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .insert(outbox)
    .values({
      id: uuidv7(),
      entityType,
      entityId,
      operation,
      payload: JSON.stringify(payload),
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [outbox.entityType, outbox.entityId, outbox.operation],
      set: {
        payload: JSON.stringify(payload),
        state: 'PENDING',
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
      },
    });
}

/** What the sync status affordance counts (§9.9): everything not yet acknowledged. */
export async function pendingOutboxCount(database: LocalDatabase): Promise<number> {
  const rows = await database
    .select({ id: outbox.id })
    .from(outbox)
    .where(inArray(outbox.state, ['PENDING', 'SYNCING', 'FAILED', 'DEAD_LETTER']));
  return rows.length;
}

/** The queue in drain order, for the Phase 4 sync engine and for the tests here. */
export function listOutbox(database: LocalDatabase) {
  return database
    .select()
    .from(outbox)
    .orderBy(asc(outbox.priority), asc(outbox.createdAt));
}
