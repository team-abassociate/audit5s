import { z } from 'zod';
import {
  booleanQuery,
  clearable,
  isoDateTimeSchema,
  optional,
  paginationQuerySchema,
  uuidSchema,
} from './common';
import {
  assignmentStatusSchema,
  auditStatusSchema,
  auditTypeSchema,
  auditZoneStatusSchema,
  locationProviderSchema,
  responseValueSchema,
  sSectionSchema,
  syncStateSchema,
} from './enums';
import { ZONE_NUMBER_MAX, ZONE_NUMBER_MIN } from './zone';

/**
 * Assignments, audits, audit Zones and question responses (ARCHITECTURE.md §5.5, §8.6).
 *
 * Three properties of these shapes are load-bearing rather than stylistic:
 *
 *   - **The client supplies the id.** `audit`, `audit_zone` and `question_response` are all
 *     keyed on a UUIDv7 the device generates offline (D12). That is what makes every write
 *     a `PUT` upsert and every retry harmless: a resent batch updates the same row.
 *   - **No score is an input.** A percentage never appears in a request shape. The server
 *     recomputes from the responses (D5); the device's number is display-only.
 *   - **No delete shape exists**, for anybody, ever (D8, A-1). `CANCELLED` is a status.
 */

// ---------------------------------------------------------------------------- location

/**
 * A location reading, exactly as the OS reported it.
 *
 * `isMocked` is recorded and never trusted as proof: CH-4 is explicit that GPS on a
 * consumer device is corroboration, not evidence, and §12.9 says the platform states that
 * honestly rather than pretending otherwise. Nothing here ever blocks an audit.
 */
export const locationReadingSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative().max(100_000).nullable().optional(),
  provider: locationProviderSchema.default('UNKNOWN'),
  isMocked: z.boolean().default(false),
  capturedAt: isoDateTimeSchema.optional(),
});
export type LocationReading = z.infer<typeof locationReadingSchema>;

// -------------------------------------------------------------------------- assignments

export const auditAssignmentSchema = z.object({
  id: uuidSchema,
  unitId: uuidSchema,
  unitName: z.string(),
  auditorUserId: uuidSchema,
  auditorName: z.string(),
  auditType: auditTypeSchema,
  status: assignmentStatusSchema,
  dueAt: isoDateTimeSchema.nullable(),
  instructions: z.string().nullable(),
  /** Hints for the auditor's Zone picker; they may audit others (§5.5). */
  suggestedZoneIds: z.array(uuidSchema),
  createdByUserId: uuidSchema,
  cancelledAt: isoDateTimeSchema.nullable(),
  cancelReason: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AuditAssignment = z.infer<typeof auditAssignmentSchema>;

/**
 * Eligibility is checked by the service: an active Consultant receives temporary Unit
 * access from this assignment; a Zone Leader must already belong to the Unit.
 */
export const createAuditAssignmentRequestSchema = z.object({
  unitId: uuidSchema,
  auditorUserId: uuidSchema,
  auditType: auditTypeSchema,
  dueAt: isoDateTimeSchema.optional(),
  instructions: optional(z.string().trim().max(2000)),
  suggestedZoneIds: z.array(uuidSchema).max(100).optional(),
});
export type CreateAuditAssignmentRequest = z.infer<typeof createAuditAssignmentRequestSchema>;

export const cancelAuditAssignmentRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type CancelAuditAssignmentRequest = z.infer<typeof cancelAuditAssignmentRequestSchema>;

export const listAuditAssignmentsQuerySchema = paginationQuerySchema.extend({
  unitId: uuidSchema.optional(),
  auditorUserId: uuidSchema.optional(),
  status: assignmentStatusSchema.optional(),
  /** Excludes CANCELLED, COMPLETED and EXPIRED — what a device needs in its catalogue. */
  open: booleanQuery(false),
});
export type ListAuditAssignmentsQuery = z.infer<typeof listAuditAssignmentsQuerySchema>;

// ------------------------------------------------------------------------------ scoring

/**
 * The score response shape of §8.6, **identical in every scoring context** — a section, a
 * Zone, an audit, or the selected Zones of a summary — so one renderer serves all of them.
 *
 * `pct: null` means "nothing applicable" (D4). It renders `N/A` and is excluded from its
 * parent; it is not `0`, and a client that treats it as `0` is producing a different report
 * from the one the business signs.
 */
export const scoreTotalsSchema = z.object({
  applicableQuestions: z.number().int().nonnegative(),
  naQuestions: z.number().int().nonnegative(),
  rawScore: z.number().int().nonnegative(),
  maxScore: z.number().int().nonnegative(),
  scorePercentage: z.number().nullable(),
});
export type ScoreTotalsPayload = z.infer<typeof scoreTotalsSchema>;

export const sectionScoreSchema = z.object({
  section: sSectionSchema,
  applicable: z.number().int().nonnegative(),
  na: z.number().int().nonnegative(),
  raw: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
  pct: z.number().nullable(),
});
export type SectionScorePayload = z.infer<typeof sectionScoreSchema>;

export const scoreSummarySchema = z.object({
  auditId: uuidSchema,
  /** Null when the summary is the whole audit rather than one of its Zones. */
  auditZoneId: uuidSchema.nullable(),
  totals: scoreTotalsSchema,
  /** Always all five sections, in workbook order, so a renderer never fills gaps. */
  sections: z.array(sectionScoreSchema),
});
export type ScoreSummary = z.infer<typeof scoreSummarySchema>;

/** `GET /audits/{id}/summary` (§8.6). Explicitly **not** an official report (N6). */
export const auditScoreSummarySchema = z.object({
  /**
   * False for a `WALK_BY`. Every `totals` and `sections` below is then empty with a `null`
   * percentage — not a score of zero, and not a score yet to arrive (§2.7, PART 11).
   */
  scored: z.boolean(),
  audit: scoreSummarySchema,
  zones: z.array(
    scoreSummarySchema.extend({
      zoneCode: z.string(),
      zoneName: z.string(),
      checklistTemplateName: z.string().nullable(),
      status: auditZoneStatusSchema,
    }),
  ),
});
export type AuditScoreSummary = z.infer<typeof auditScoreSummarySchema>;

// ------------------------------------------------------------------------------- audits

export const auditSchema = z.object({
  id: uuidSchema,
  assignmentId: uuidSchema.nullable(),
  unitId: uuidSchema,
  unitName: z.string(),
  auditType: auditTypeSchema,
  status: auditStatusSchema,
  /**
   * False for a `WALK_BY`, whose §2.7 opens "No questionnaire, no score".
   *
   * Stated on the response rather than left for each reader to re-derive from
   * `auditType`. `totals` on a walk-by is all zeros with a `null` percentage, which is
   * indistinguishable from a scored audit nobody has answered yet — and the difference
   * matters: one will have a score, the other never will. A client that renders `0 / 0`
   * as a result, or an analytics query that averages it in, is reading the field that
   * does not say which case this is. PART 11's "walk-by audits are excluded from every
   * score metric" is this flag.
   */
  scored: z.boolean(),
  auditorUserId: uuidSchema,
  auditorName: z.string(),
  /** The single-writer lock (D7). Null once released. */
  owningDeviceId: uuidSchema.nullable(),
  /** Audit-level default; the binding version is the one on each `AuditZone`. */
  checklistVersionId: uuidSchema.nullable(),
  selfieEvidenceId: uuidSchema.nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  closedAt: isoDateTimeSchema.nullable(),
  startLatitude: z.number().nullable(),
  startLongitude: z.number().nullable(),
  startAccuracyM: z.number().nullable(),
  startLocationProvider: locationProviderSchema.nullable(),
  /** Reported by the OS; advisory only, and it never blocks anything (CH-4). */
  startLocationIsMocked: z.boolean().nullable(),
  startDistanceFromUnitM: z.number().nullable(),
  locationSuspicious: z.boolean(),
  totals: scoreTotalsSchema,
  pausedAt: isoDateTimeSchema.nullable(),
  pauseReason: z.string().nullable(),
  /** Resume cursor at audit level (§9.8). */
  resumeAuditZoneId: uuidSchema.nullable(),
  clientCreatedAt: isoDateTimeSchema,
  clientUpdatedAt: isoDateTimeSchema,
  serverReceivedAt: isoDateTimeSchema,
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Audit = z.infer<typeof auditSchema>;

export const auditZoneSchema = z.object({
  id: uuidSchema,
  auditId: uuidSchema,
  /** The live pointer. Everything the report renders comes from the snapshots below (D6). */
  zoneId: uuidSchema,
  sequenceNo: z.number().int(),
  status: auditZoneStatusSchema,
  zoneCodeSnapshot: z.string(),
  zoneNameSnapshot: z.string(),
  zoneDescriptionSnapshot: z.string().nullable(),
  zoneLeaderUserIdSnapshot: uuidSchema.nullable(),
  /** Survives even a user rename, which is the point of snapshotting the name too. */
  zoneLeaderNameSnapshot: z.string().nullable(),
  /** **The binding version** for this Zone's questions (QR-2). */
  checklistVersionId: uuidSchema.nullable(),
  checklistTemplateNameSnapshot: z.string().nullable(),
  zoneRemark: z.string().nullable(),
  totals: scoreTotalsSchema,
  sections: z.array(sectionScoreSchema),
  /** Resume cursor within the Zone (N7, §9.8). */
  resumeQuestionId: uuidSchema.nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  clientUpdatedAt: isoDateTimeSchema,
  version: z.number().int(),
});
export type AuditZone = z.infer<typeof auditZoneSchema>;

export const questionResponseSchema = z.object({
  id: uuidSchema,
  auditZoneId: uuidSchema,
  auditId: uuidSchema,
  checklistQuestionId: uuidSchema,
  section: sSectionSchema,
  globalOrder: z.number().int(),
  value: responseValueSchema,
  /** `null` iff `value` is `NA` — invariant QR-1, a CHECK constraint in the database. */
  numericScore: z.number().int().nullable(),
  remark: z.string().nullable(),
  answeredAt: isoDateTimeSchema,
  clientUpdatedAt: isoDateTimeSchema,
  syncState: syncStateSchema,
});
export type QuestionResponse = z.infer<typeof questionResponseSchema>;

/**
 * `GET /audits/{auditId}/zone-locks` — the Zones of this audit's Unit that another open
 * audit is already holding (R-29).
 *
 * A Unit may be assigned to two Consultants who walk it on the same morning. Nothing in
 * the schema stopped both of them from auditing Zone 1, and two independent scores for one
 * Zone on one day is not a disagreement the report can render — it is a duplicate. So a
 * Zone claimed by an open audit is claimed until that audit completes, is cancelled, or
 * releases it.
 *
 * The lock is a read the picker uses to grey a row out. It is a courtesy, not the control:
 * `audit_zone`'s trigger is the control, and it refuses the insert whether it arrives over
 * HTTP or through a sync batch pushed three days later.
 */
export const zoneLockSchema = z.object({
  zoneId: uuidSchema,
  /** `Z01`… — what the picker matches on, since a device may not know the Zone's id. */
  zoneCode: z.string(),
  zoneName: z.string(),
  /** The audit holding it. Never this audit — the response excludes the caller's own. */
  auditId: uuidSchema,
  auditorName: z.string(),
  auditStatus: auditStatusSchema,
});
export type ZoneLock = z.infer<typeof zoneLockSchema>;

export const zoneLocksResponseSchema = z.object({
  auditId: uuidSchema,
  unitId: uuidSchema,
  locks: z.array(zoneLockSchema),
});
export type ZoneLocksResponse = z.infer<typeof zoneLocksResponseSchema>;

/** `GET /audits/{id}` — the audit with its Zones and their responses. */
export const auditDetailSchema = auditSchema.extend({
  zones: z.array(auditZoneSchema.extend({ responses: z.array(questionResponseSchema) })),
});
export type AuditDetail = z.infer<typeof auditDetailSchema>;

/**
 * `POST /audits`. `id` is the device's UUIDv7, so a retried creation returns the existing
 * audit rather than opening a second one.
 */
export const createAuditRequestSchema = z.object({
  id: uuidSchema,
  auditType: auditTypeSchema,
  unitId: uuidSchema,
  assignmentId: uuidSchema.optional(),
  checklistVersionId: uuidSchema.optional(),
  /** Which device is claiming this audit. Also read from `X-Device-Id` when absent. */
  deviceId: uuidSchema.optional(),
  /** Phase 4 makes this mandatory for EXTERNAL_5S / CROSS_5S / WALK_BY, once evidence exists. */
  selfieEvidenceId: uuidSchema.optional(),
  location: locationReadingSchema.optional(),
  clientCreatedAt: isoDateTimeSchema.optional(),
});
export type CreateAuditRequest = z.infer<typeof createAuditRequestSchema>;

export const startAuditRequestSchema = z.object({
  deviceId: uuidSchema.optional(),
  location: locationReadingSchema.optional(),
  startedAt: isoDateTimeSchema.optional(),
});
export type StartAuditRequest = z.infer<typeof startAuditRequestSchema>;

/** Abort (N7). Saving is never conditional on any of these being supplied. */
export const pauseAuditRequestSchema = z.object({
  reason: optional(z.string().trim().max(1000)),
  resumeAuditZoneId: uuidSchema.optional(),
  resumeQuestionId: uuidSchema.optional(),
});
export type PauseAuditRequest = z.infer<typeof pauseAuditRequestSchema>;

export const resumeAuditRequestSchema = z.object({
  deviceId: uuidSchema.optional(),
});
export type ResumeAuditRequest = z.infer<typeof resumeAuditRequestSchema>;

export const completeAuditRequestSchema = z.object({
  completedAt: isoDateTimeSchema.optional(),
});
export type CompleteAuditRequest = z.infer<typeof completeAuditRequestSchema>;

export const cancelAuditRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type CancelAuditRequest = z.infer<typeof cancelAuditRequestSchema>;

/**
 * `POST /audits/{id}/release-device` — D7's force-release (§9.5 Layer 1).
 *
 * The reason is required rather than optional for the same reason the cancellation's is:
 * the point of the endpoint is the `AuditLog` entry it writes. Breaking a single-writer
 * lock without saying why is the case the audit trail exists to prevent.
 */
export const releaseDeviceRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type ReleaseDeviceRequest = z.infer<typeof releaseDeviceRequestSchema>;

/**
 * `PATCH /audits/{id}/post-completion` — the **only** way a completed audit changes (A-2).
 *
 * The justification is required rather than optional because the whole point of the route
 * is the `AuditLog` entry it writes: an override with no stated reason is the case the
 * invariant exists to prevent.
 */
export const postCompletionOverrideRequestSchema = z.object({
  justification: z.string().trim().min(10).max(2000),
  changes: z
    .object({
      /** Reopen one Zone of the audit so its responses can be corrected. */
      reopenAuditZoneId: uuidSchema.optional(),
      zoneRemark: z
        .object({ auditZoneId: uuidSchema, remark: z.string().trim().max(4000).nullable() })
        .optional(),
      responses: z
        .array(
          z.object({
            responseId: uuidSchema,
            value: responseValueSchema,
            remark: clearable(z.string().trim().max(2000)),
          }),
        )
        .max(50)
        .optional(),
    })
    .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
      message: 'An override must change something',
    }),
});
export type PostCompletionOverrideRequest = z.infer<typeof postCompletionOverrideRequestSchema>;

export const listAuditsQuerySchema = paginationQuerySchema.extend({
  unitId: uuidSchema.optional(),
  status: auditStatusSchema.optional(),
  type: auditTypeSchema.optional(),
  auditorId: uuidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  /** The live audit board: ASSIGNED, READY, IN_PROGRESS and PAUSED only. */
  active: booleanQuery(false),
});
export type ListAuditsQuery = z.infer<typeof listAuditsQuerySchema>;

/**
 * `PUT /audits/{auditId}/zones/{auditZoneId}` — the upsert that takes the D6 snapshots.
 *
 * The snapshots are taken by the server on first write and never again, so a later write
 * cannot rewrite history. What the auditor *enters* when creating the Zone — its
 * description and its leader's name (R-19) — is part of what was audited, and is copied on
 * that first write like everything else.
 */
export const upsertAuditZoneRequestSchema = z
  .object({
    /** A Zone picked from the Unit's master list. Ignored when `zoneNumber` is sent. */
    zoneId: uuidSchema.optional(),
    /**
     * R-19 — the Zone 1…100 the auditor chose. The server uses that Zone of the audit's
     * Unit, adding it to the Unit's master list the first time any audit names it. Sent
     * instead of an id because a device offline cannot know the id of a Zone that does not
     * exist yet.
     */
    zoneNumber: z.number().int().min(ZONE_NUMBER_MIN).max(ZONE_NUMBER_MAX).optional(),
    sequenceNo: z.number().int().min(1).max(1000),
    /** The department whose fifty questions this Zone answers (QR-2). */
    checklistVersionId: uuidSchema.optional(),
    /**
     * Optional on every audit type (§2.7 step 3, R-19). Absent or empty, the server copies
     * the Zone's own description.
     */
    zoneDescription: clearable(z.string().trim().max(2000)),
    /**
     * R-19 — the Zone leader's name as the auditor typed it. A name, not an account: it is
     * printed on the reports and routes nothing. Absent or empty, the Zone's own leader is
     * used.
     */
    zoneLeaderName: clearable(z.string().trim().max(200)),
    /**
     * §2.7 step 4 on a walk-by, for a leader picked from accounts. Must name a
     * `ZONE_LEADER` holding an ACTIVE membership in the audit's Unit, or the request is
     * `422 ZONE_LEADER_NOT_IN_UNIT`.
     */
    zoneLeaderUserId: uuidSchema.optional(),
    zoneRemark: clearable(z.string().trim().max(4000)),
    resumeQuestionId: uuidSchema.nullable().optional(),
    clientUpdatedAt: isoDateTimeSchema.optional(),
  })
  .refine((body) => body.zoneNumber !== undefined || body.zoneId !== undefined, {
    message: 'Name the Zone with zoneNumber or zoneId',
    path: ['zoneNumber'],
  });
export type UpsertAuditZoneRequest = z.infer<typeof upsertAuditZoneRequestSchema>;

export const completeAuditZoneRequestSchema = z.object({
  zoneRemark: clearable(z.string().trim().max(4000)),
  completedAt: isoDateTimeSchema.optional(),
});
export type CompleteAuditZoneRequest = z.infer<typeof completeAuditZoneRequestSchema>;

/**
 * `PUT /audit-zones/{auditZoneId}/responses/{responseId}`.
 *
 * `numericScore` is absent: it is derived from `value` by `packages/domain` on the way in,
 * because QR-1 makes the pair a database constraint and a client that disagreed with it
 * would simply be refused. Sending the derivation would be sending something that cannot
 * differ from what is already sent.
 */
export const upsertQuestionResponseRequestSchema = z.object({
  checklistQuestionId: uuidSchema,
  value: responseValueSchema,
  remark: clearable(z.string().trim().max(2000)),
  answeredAt: isoDateTimeSchema,
  clientUpdatedAt: isoDateTimeSchema.optional(),
});
export type UpsertQuestionResponseRequest = z.infer<typeof upsertQuestionResponseRequestSchema>;
