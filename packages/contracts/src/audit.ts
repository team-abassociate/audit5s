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
 * Invariant AA-1 is checked by the service, not expressible here: the assignee must hold an
 * ACTIVE membership in `unitId` at creation.
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
 * The snapshot fields are absent by construction: they are read from the live Zone by the
 * server on first write and never again. A client cannot supply them, so a client cannot
 * rewrite history by supplying different ones.
 */
export const upsertAuditZoneRequestSchema = z.object({
  zoneId: uuidSchema,
  sequenceNo: z.number().int().min(1).max(1000),
  checklistVersionId: uuidSchema.optional(),
  zoneRemark: clearable(z.string().trim().max(4000)),
  resumeQuestionId: uuidSchema.nullable().optional(),
  clientUpdatedAt: isoDateTimeSchema.optional(),
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
