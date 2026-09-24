import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type {
  AuditType,
  LocationReading,
  ResponseValue,
  SSection,
} from '@audit5s/contracts';
import {
  numericScoreFor,
  scoreZone,
  zoneCodeForNumber,
  zoneLeaderSnapshot,
  zoneNumberFromCode,
  type ScoreBreakdown,
} from '@audit5s/domain';
import type { LocalDatabase } from './local-database';
import {
  audits,
  checklistQuestions,
  units,
  checklistVersions,
  localAuditZones,
  localQuestionResponses,
  outbox,
  zones,
  type OutboxOperation,
  type OutboxQueue,
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
  /** The Zone 1…100 the auditor chose (R-19). */
  zoneNumber: number;
  sequenceNo: number;
  /** The department whose fifty questions this Zone answers; null on a walk-by. */
  checklistVersionId: string | null;
  zoneDescription?: string | null;
  /** The Zone leader's name, as the auditor typed it (R-19). */
  zoneLeaderName?: string | null;
  id?: string;
  now?: string;
}

/**
 * Adds a Zone to the audit by its number, taking the D6 snapshots on the device.
 *
 * The Zone need not be in the catalogue (R-19): an auditor may name a Zone nobody has
 * created yet, and the server adds it to the Unit when this write arrives. So the row points
 * at the catalogue Zone when there is one and at a local id when there is not, and the
 * outbox names the Zone by its number — never by that local id.
 *
 * The device snapshots for the same reason the server does: what the report renders must
 * not move when the Zone is edited later. The server takes its own copy on the way in and
 * does not trust these — but the device needs them to render the questionnaire header
 * offline, so both hold a snapshot and the server's is authoritative.
 */
export async function addLocalZone(
  database: LocalDatabase,
  input: AddZoneInput,
): Promise<string> {
  const id = input.id ?? uuidv7();
  const now = input.now ?? new Date().toISOString();

  const [audit] = await database
    .select({ unitId: audits.unitId })
    .from(audits)
    .where(eq(audits.id, input.auditId))
    .limit(1);
  if (!audit) {
    throw new Error(`Audit ${input.auditId} is not on this device`);
  }

  const code = zoneCodeForNumber(input.zoneNumber);

  // The server's `UNIQUE (audit_id, zone_id)`, checked by code: a Zone not in the catalogue
  // has a fresh local id every time, so the local index alone would not catch a repeat.
  const [repeat] = await database
    .select({ id: localAuditZones.id })
    .from(localAuditZones)
    .where(
      and(
        eq(localAuditZones.auditId, input.auditId),
        eq(localAuditZones.zoneCodeSnapshot, code),
        // A withdrawn Zone left the audit (0031), so it may be started again.
        sql`${localAuditZones.status} <> 'WITHDRAWN'`,
      ),
    )
    .limit(1);
  if (repeat) {
    throw new Error(`Zone ${input.zoneNumber} is already part of this audit`);
  }

  const [zone] = await database
    .select()
    .from(zones)
    .where(and(eq(zones.unitId, audit.unitId), eq(zones.code, code)))
    .limit(1);
  if (zone?.archived) {
    throw new Error(`Zone ${input.zoneNumber} is archived in this Unit`);
  }

  const version = input.checklistVersionId
    ? (
        await database
          .select({ templateName: checklistVersions.templateName })
          .from(checklistVersions)
          .where(eq(checklistVersions.id, input.checklistVersionId))
          .limit(1)
      )[0]
    : undefined;
  if (input.checklistVersionId && !version) {
    throw new Error(`Checklist ${input.checklistVersionId} is not on this device`);
  }

  const typedDescription = input.zoneDescription?.trim() || null;
  const typedLeader = input.zoneLeaderName?.trim() || null;
  const leader = zoneLeaderSnapshot(zone, typedLeader);

  await database.insert(localAuditZones).values({
    id,
    auditId: input.auditId,
    zoneId: zone?.id ?? uuidv7(),
    sequenceNo: input.sequenceNo,
    status: 'DRAFT',
    zoneCodeSnapshot: code,
    zoneNameSnapshot: zone?.name ?? `Zone ${input.zoneNumber}`,
    zoneDescriptionSnapshot: typedDescription ?? zone?.description ?? null,
    zoneLeaderUserIdSnapshot: leader.userId,
    zoneLeaderNameSnapshot: leader.name,
    checklistVersionId: input.checklistVersionId,
    checklistTemplateNameSnapshot: version?.templateName ?? null,
    clientUpdatedAt: now,
  });

  await database
    .update(audits)
    .set({ resumeAuditZoneId: id, clientUpdatedAt: now })
    .where(eq(audits.id, input.auditId));

  await enqueue(database, 'audit_zone', id, 'upsert', {
    auditId: input.auditId,
    zoneNumber: input.zoneNumber,
    sequenceNo: input.sequenceNo,
    checklistVersionId: input.checklistVersionId ?? undefined,
    ...(typedDescription ? { zoneDescription: typedDescription } : {}),
    ...(typedLeader ? { zoneLeaderName: typedLeader } : {}),
  });

  return id;
}

/**
 * R-34: correcting the Zone details the auditor typed, on a Zone already in the audit.
 *
 * `addLocalZone` writes these once and this is how they change afterwards — the
 * description, the leader's name, and the department for a scored Zone. The Zone *number*
 * is deliberately not among them: changing it would re-point the audit Zone at a different
 * master Zone, which R-29's claim and the one-Zone-per-audit rule both have opinions
 * about, and those are the server's to enforce rather than a phone's to assume.
 *
 * The same outbox operation the Zone was added with. It coalesces on
 * `(entity_type, entity_id, operation)`, so correcting a Zone three times offline sends
 * the last state once rather than three upserts racing each other.
 */
export async function editLocalZone(
  database: LocalDatabase,
  input: {
    auditZoneId: string;
    zoneDescription?: string | null;
    zoneLeaderName?: string | null;
    checklistVersionId?: string | null;
    now?: string;
  },
): Promise<void> {
  const now = input.now ?? new Date().toISOString();

  const [existing] = await database
    .select()
    .from(localAuditZones)
    .where(eq(localAuditZones.id, input.auditZoneId))
    .limit(1);
  if (!existing) {
    throw new Error(`Audit Zone ${input.auditZoneId} is not on this device`);
  }

  const typedDescription = input.zoneDescription?.trim() || null;
  const typedLeader = input.zoneLeaderName?.trim() || null;

  const version = input.checklistVersionId
    ? (
        await database
          .select({ templateName: checklistVersions.templateName })
          .from(checklistVersions)
          .where(eq(checklistVersions.id, input.checklistVersionId))
          .limit(1)
      )[0]
    : undefined;

  await database
    .update(localAuditZones)
    .set({
      ...(input.zoneDescription !== undefined
        ? { zoneDescriptionSnapshot: typedDescription }
        : {}),
      ...(input.zoneLeaderName !== undefined ? { zoneLeaderNameSnapshot: typedLeader } : {}),
      ...(input.checklistVersionId !== undefined
        ? {
            checklistVersionId: input.checklistVersionId,
            checklistTemplateNameSnapshot: version?.templateName ?? null,
          }
        : {}),
      clientUpdatedAt: now,
    })
    .where(eq(localAuditZones.id, input.auditZoneId));

  await enqueue(database, 'audit_zone', input.auditZoneId, 'upsert', {
    auditId: existing.auditId,
    zoneNumber: zoneNumberFromCode(existing.zoneCodeSnapshot) ?? undefined,
    sequenceNo: existing.sequenceNo,
    checklistVersionId:
      (input.checklistVersionId ?? existing.checklistVersionId) || undefined,
    // Sent even when cleared, so the server can tell "unchanged" from "emptied" — only a
    // field the request carries is ever re-snapshotted (R-34).
    ...(input.zoneDescription !== undefined ? { zoneDescription: typedDescription } : {}),
    ...(input.zoneLeaderName !== undefined ? { zoneLeaderName: typedLeader } : {}),
  });
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

  /**
   * The Zone moves off DRAFT on the first answer, and the cursor follows the last one, so
   * an abort a moment later resumes exactly here (§9.8).
   *
   * A Zone already COMPLETED keeps that status. Revising a finished Zone from the Review
   * button is allowed until the audit itself is finished, and the server treats it exactly
   * this way — it rescores the audit and leaves the Zone finished. Reopening it here
   * instead put the device a status out of step with the server and, worse, disabled
   * "Finish audit" until the auditor found their way back to a Submit button five pages
   * down. `COMPLETED → IN_PROGRESS` is a Super Admin's reopen (§7.2), not a side effect of
   * correcting a mark.
   */
  await database
    .update(localAuditZones)
    .set({
      // A withdrawn Zone stays withdrawn too: it left the audit, and only starting the Zone
      // again brings it back — as a new audit Zone.
      status: sql`CASE WHEN ${localAuditZones.status} IN ('COMPLETED', 'WITHDRAWN') THEN ${localAuditZones.status} ELSE 'IN_PROGRESS' END`,
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

/**
 * Stores the start location on the audit, and re-queues the creation payload with it.
 *
 * §12.9 computes the distance and the flag **server-side**, from the Unit's own
 * coordinates — so the device sends the raw reading and nothing derived from it. A null
 * reading is stored as null and flagged by the server as `LOCATION_ABSENT`; it is never a
 * reason to stop.
 */
export async function recordAuditStartLocation(
  database: LocalDatabase,
  auditId: string,
  location: LocationReading | null,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .update(audits)
    .set({
      startLatitude: location?.latitude ?? null,
      startLongitude: location?.longitude ?? null,
      startAccuracyM: location?.accuracyM ?? null,
      startLocationProvider: location?.provider ?? null,
      startLocationIsMocked: location?.isMocked ? 1 : 0,
      clientUpdatedAt: now,
    })
    .where(eq(audits.id, auditId));

  const [audit] = await getLocalAudit(database, auditId);
  if (!audit) return;

  await enqueue(
    database,
    'audit',
    auditId,
    'upsert',
    {
      id: auditId,
      auditType: audit.auditType,
      unitId: audit.unitId,
      ...(audit.assignmentId ? { assignmentId: audit.assignmentId } : {}),
      ...(audit.checklistVersionId ? { checklistVersionId: audit.checklistVersionId } : {}),
      clientCreatedAt: audit.clientCreatedAt,
      ...(location
        ? {
            location: {
              latitude: location.latitude,
              longitude: location.longitude,
              accuracyM: location.accuracyM ?? null,
              provider: location.provider,
              isMocked: location.isMocked,
              capturedAt: location.capturedAt ?? now,
            },
          }
        : {}),
    },
    now,
  );
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
    // The outbox coalesces this with a first write that has not synced yet, so it must carry
    // everything that write did — the Zone by number above all, since a Zone the catalogue
    // lacked has only a local id the server has never seen (R-19).
    const zoneNumber = zoneNumberFromCode(zone.zoneCodeSnapshot);
    await enqueue(database, 'audit_zone', auditZoneId, 'upsert', {
      auditId: zone.auditId,
      ...(zoneNumber !== null ? { zoneNumber } : { zoneId: zone.zoneId }),
      sequenceNo: zone.sequenceNo,
      checklistVersionId: zone.checklistVersionId ?? undefined,
      zoneDescription: zone.zoneDescriptionSnapshot,
      zoneLeaderName: zone.zoneLeaderNameSnapshot,
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
  const [zone] = await getLocalAuditZone(database, auditZoneId);

  await database
    .update(localAuditZones)
    .set({ status: 'COMPLETED', completedAt: now, resumeQuestionId: null, clientUpdatedAt: now })
    .where(eq(localAuditZones.id, auditZoneId));

  if (zone) {
    await database
      .update(audits)
      .set({ resumeAuditZoneId: null, clientUpdatedAt: now })
      .where(and(eq(audits.id, zone.auditId), eq(audits.resumeAuditZoneId, auditZoneId)));
  }

  // `auditId` rides in the payload because §8.6 addresses this as
  // `/audits/{auditId}/zones/{auditZoneId}/complete` — the outbox row carries the entity id
  // in its own column, and everything else the route needs has to be in the payload.
  await enqueue(database, 'audit_zone', auditZoneId, 'complete', {
    ...(zone ? { auditId: zone.auditId } : {}),
    completedAt: now,
  });
}

/**
 * Abort **one Zone**: an unfinished Zone leaves the audit.
 *
 * Nothing is deleted — its answers and photographs stay on this device and on the server
 * (A-1). The status becomes WITHDRAWN, which takes the Zone out of the audit's score and
 * out of what *Finish audit* waits for, and frees it so it can be started again, in this
 * audit or another. A finished Zone is not withdrawn: it is part of the audit, and a change
 * to it is a review.
 *
 * The resume cursor is cleared when it points here, so *Resume* never reopens a Zone the
 * auditor walked away from.
 */
export async function withdrawLocalZone(
  database: LocalDatabase,
  auditZoneId: string,
  reason: string | null,
  now: string = new Date().toISOString(),
): Promise<void> {
  const [zone] = await getLocalAuditZone(database, auditZoneId);
  if (!zone || zone.status === 'COMPLETED' || zone.status === 'WITHDRAWN') return;

  await database
    .update(localAuditZones)
    .set({ status: 'WITHDRAWN', resumeQuestionId: null, clientUpdatedAt: now })
    .where(eq(localAuditZones.id, auditZoneId));

  await database
    .update(audits)
    .set({ resumeAuditZoneId: null, clientUpdatedAt: now })
    .where(and(eq(audits.id, zone.auditId), eq(audits.resumeAuditZoneId, auditZoneId)));

  await enqueue(database, 'audit_zone', auditZoneId, 'withdraw', {
    auditId: zone.auditId,
    ...(reason ? { reason } : {}),
    withdrawnAt: now,
  });
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

/**
 * R-33: the way back from an accidental *Finish audit*, authored on the phone.
 *
 * Two writes, in the order that makes an interruption harmless. The local status goes back
 * to IN_PROGRESS first, so the auditor can carry on immediately — the whole point is that
 * this works in a plant with no signal — and the outbox row follows. If the app dies
 * between them the audit is editable locally and the server still thinks it is finished,
 * which the next `complete` reconciles; the reverse order would queue a restart for an
 * audit the auditor cannot yet touch.
 *
 * The count rises locally too, so the button says "1 left" straight away rather than after
 * the next sync. The server keeps its own count and is the one that refuses a third — this
 * is the screen's copy, not the control.
 */
export async function restartLocalAudit(
  database: LocalDatabase,
  auditId: string,
  justification: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  const [audit] = await database.select().from(audits).where(eq(audits.id, auditId)).limit(1);
  if (!audit) return;

  await database
    .update(audits)
    .set({
      status: 'IN_PROGRESS',
      completedAt: null,
      restartCount: (audit.restartCount ?? 0) + 1,
      clientUpdatedAt: now,
    })
    .where(eq(audits.id, auditId));

  await enqueue(database, 'audit', auditId, 'restart', { justification });
}

/**
 * A correction to an audit that is already finished (R-30, A-2).
 *
 * The auditor who conducted an audit may fix a mark on it afterwards, and this is the only
 * way the device sends one. It is deliberately **not** `saveLocalResponse`: that enqueues a
 * `question_response:upsert`, which a completed audit refuses — in the service, and again
 * in the trigger — and which carries no reason to write to the audit log. The correction
 * rides `PATCH /audits/{id}/post-completion` instead, the same door the web override uses.
 *
 * Two writes, in the order that makes an interruption harmless:
 *
 *   1. The local response row, so the screen and the device's own scoring show the mark the
 *      auditor just chose rather than waiting on a round trip.
 *   2. One outbox row per audit, merged. A second correction to the same audit updates the
 *      same row — the outbox coalesces on `(entity_type, entity_id, operation)` and would
 *      otherwise *replace* the payload, losing the first correction. So the pending payload
 *      is read, merged by response id, and written back.
 *
 * The justification is the latest one given: corrections made in one sitting share a
 * reason, and the server logs it with the before and after of every change it carries.
 */
export async function applyLocalOverride(
  database: LocalDatabase,
  input: {
    auditId: string;
    responseId: string;
    value: ResponseValue;
    remark?: string | null;
    justification: string;
  },
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .update(localQuestionResponses)
    .set({
      value: input.value,
      numericScore: numericScoreFor(input.value),
      remark: input.remark ?? null,
      clientUpdatedAt: now,
    })
    .where(eq(localQuestionResponses.id, input.responseId));

  const [pending] = await database
    .select({ payload: outbox.payload })
    .from(outbox)
    .where(
      and(
        eq(outbox.entityType, 'audit'),
        eq(outbox.entityId, input.auditId),
        eq(outbox.operation, 'override'),
      ),
    )
    .limit(1);

  const queued = readOverridePayload(pending?.payload);
  const merged = queued.filter((change) => change.responseId !== input.responseId);
  merged.push({
    responseId: input.responseId,
    value: input.value,
    ...(input.remark === undefined ? {} : { remark: input.remark }),
  });

  await enqueue(database, 'audit', input.auditId, 'override', {
    justification: input.justification,
    changes: { responses: merged },
  });
}

interface OverrideChange {
  responseId: string;
  value: ResponseValue;
  remark?: string | null;
}

/**
 * The corrections already queued for this audit.
 *
 * A payload that will not parse is treated as no corrections rather than throwing. The row
 * is the device's own JSON and should always read, but a correction refused because an
 * older build wrote a shape this one cannot understand would be a correction lost for good
 * — and the merge below rewrites the row completely anyway.
 */
function readOverridePayload(payload: string | undefined): OverrideChange[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as { changes?: { responses?: OverrideChange[] } };
    return parsed.changes?.responses ?? [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------------------ reads

export function getLocalAudit(database: LocalDatabase, auditId: string) {
  return database.select().from(audits).where(eq(audits.id, auditId)).limit(1);
}

/** The History tab: this device's audits, newest first. */
/** The device's audits, newest first, each with its Unit's cached name for the History list. */
export function listLocalAudits(database: LocalDatabase) {
  return database
    .select({ ...getTableColumns(audits), unitName: units.name })
    .from(audits)
    .leftJoin(units, eq(units.id, audits.unitId))
    .orderBy(sql`${audits.clientUpdatedAt} DESC`);
}

/** The statuses an audit can be resumed from — everything before it is finished. */
const RESUMABLE = ['ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'] as const;

export interface ResumableAudit {
  id: string;
  unitId: string;
  unitName: string | null;
  auditType: string;
  status: string;
  startedAt: string | null;
  pausedAt: string | null;
  pauseReason: string | null;
  clientUpdatedAt: string;
  resumeAuditZoneId: string | null;
  zonesTotal: number;
  zonesFinished: number;
}

/**
 * The Overview tab's question: what is this auditor in the middle of?
 *
 * Read from SQLite like everything else on a field screen, and deliberately *not* from
 * `GET /audits?active=true`. An audit paused in a plant with no signal is in progress on
 * this device whatever the server has heard, and the point of the screen is to get back
 * into it — which is a local operation from first tap to last (§9.8).
 *
 * The Zone counts come from a second query rather than a grouped join: there are a handful
 * of rows, and the plain version is the one that stays right when the schema moves.
 */
export async function listResumableAudits(database: LocalDatabase): Promise<ResumableAudit[]> {
  const rows = await database
    .select({ ...getTableColumns(audits), unitName: units.name })
    .from(audits)
    .leftJoin(units, eq(units.id, audits.unitId))
    .where(inArray(audits.status, [...RESUMABLE]))
    .orderBy(sql`${audits.clientUpdatedAt} DESC`);

  if (rows.length === 0) return [];

  const zoneRows = await database
    .select({ auditId: localAuditZones.auditId, status: localAuditZones.status })
    .from(localAuditZones)
    .where(
      inArray(
        localAuditZones.auditId,
        rows.map((row) => row.id),
      ),
    );

  return rows.map((row) => {
    const mine = zoneRows.filter((zone) => zone.auditId === row.id && zone.status !== 'WITHDRAWN');
    return {
      id: row.id,
      unitId: row.unitId,
      unitName: row.unitName,
      auditType: row.auditType,
      status: row.status,
      startedAt: row.startedAt,
      pausedAt: row.pausedAt,
      pauseReason: row.pauseReason,
      clientUpdatedAt: row.clientUpdatedAt,
      resumeAuditZoneId: row.resumeAuditZoneId,
      zonesTotal: mine.length,
      zonesFinished: mine.filter((zone) => zone.status === 'COMPLETED').length,
    };
  });
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
      // Aliased: both tables call their key `id`, and rows come back keyed by column name.
      responseId: sql<string | null>`${localQuestionResponses.id}`.as('response_id'),
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
    .select({
      auditId: localAuditZones.auditId,
      status: localAuditZones.status,
      resumeQuestionId: localAuditZones.resumeQuestionId,
    })
    .from(localAuditZones)
    .where(eq(localAuditZones.id, auditZoneId))
    .limit(1);

  // Older device rows may still point at a Zone completed before the cursor was cleared.
  // A draft Zone has not received its first answer yet, but is still where Resume belongs.
  if (zone?.auditId !== auditId || (zone.status !== 'DRAFT' && zone.status !== 'IN_PROGRESS')) {
    return { auditZoneId: null, questionId: null, answered: 0 };
  }

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
  options: { queue?: OutboxQueue; priority?: number } = {},
): Promise<void> {
  await database
    .insert(outbox)
    .values({
      id: uuidv7(),
      entityType,
      entityId,
      operation,
      payload: JSON.stringify(payload),
      queue: options.queue ?? 'data',
      priority: options.priority ?? 100,
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
        // Cleared with the state: a coalesced re-save is a fresh attempt, and leaving a
        // stale `started_at` behind would make §9.6's sweep think it was already in flight.
        startedAt: null,
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
