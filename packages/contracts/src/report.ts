import { z } from 'zod';
import { isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common';
import {
  auditTypeSchema,
  correctiveActionStatusSchema,
  correctiveOptionSchema,
  reportKindSchema,
  reportStatusSchema,
  responseValueSchema,
  sSectionSchema,
} from './enums';
import { scoreTotalsSchema, sectionScoreSchema } from './audit';

/**
 * Reporting (ARCHITECTURE.md PART 10, §5.8, §8.9; HANDOFF.md §4).
 *
 * The shape that matters here is `reportPayloadSchema`: the **frozen** payload a snapshot
 * carries. §10.1's first principle is that a report renders from it and never from live
 * tables, so everything a page prints is in it — including the rating scale, so a report
 * reopened in December keeps the palette it was issued with, and including the signed
 * corrective-action links, because a link the renderer had to go and fetch would make the
 * same payload render differently on two days.
 *
 * `payloadSchemaVersion` is how the renderer evolves (§10.5): the worker selects a
 * renderer for the version the snapshot was frozen at, so a two-year-old snapshot still
 * renders with the layout it was designed for.
 */

export const REPORT_PAYLOAD_SCHEMA_VERSION = 1;

// ------------------------------------------------------------------- payload fragments

/** One rating band, frozen with the report (R-6b). */
export const reportBandSchema = z.object({
  token: z.string(),
  minPercentage: z.number(),
  label: z.string(),
  color: z.string(),
  tint: z.string(),
});

/**
 * A photograph as the renderer sees it.
 *
 * `objectKey` is null for a redacted photo (R-5): the object was overwritten and the page
 * prints the placeholder frame with the caption "Photo removed". The row, the caption and
 * the finding all survive, which is the whole point of redaction being the erasure path.
 */
export const reportPhotoSchema = z.object({
  evidenceId: uuidSchema,
  objectKey: z.string().nullable(),
  redacted: z.boolean(),
  remark: z.string().nullable(),
  capturedAt: isoDateTimeSchema.nullable(),
  isSummaryFlagged: z.boolean(),
  /** Null on a walk-by photograph: no questionnaire, so no question (§2.7). */
  questionGlobalOrder: z.number().int().nullable(),
  questionText: z.string().nullable(),
  section: sSectionSchema.nullable(),
  scoreAtCapture: responseValueSchema.nullable(),
});
export type ReportPhoto = z.infer<typeof reportPhotoSchema>;

/**
 * What fills a nonconformity's right half in an after-evidence report (§10.3-B).
 *
 * Null means the item is still open, and the right half prints "Pending" with the
 * deadline — which is also exactly what an initial report prints, except that there the
 * right half carries a light placeholder frame and **no text whatsoever** (§10.3-A).
 */
export const reportOutcomeSchema = z.object({
  option: correctiveOptionSchema,
  submittedByName: z.string(),
  submittedAt: isoDateTimeSchema,
  /** Option A. */
  description: z.string().nullable(),
  afterPhoto: reportPhotoSchema.nullable(),
  /** Option B. */
  explanation: z.string().nullable(),
  verified: z.boolean(),
  verifiedAt: isoDateTimeSchema.nullable(),
});
export type ReportOutcome = z.infer<typeof reportOutcomeSchema>;

export const reportNonconformitySchema = reportPhotoSchema.extend({
  correctiveActionId: uuidSchema,
  status: correctiveActionStatusSchema,
  dueAt: isoDateTimeSchema.nullable(),
  /**
   * The signed `/ca/{token}` link the PDF's button points at.
   *
   * Frozen into the payload, which means the tokens are minted **before** the render, not
   * after it as §10.2's pipeline sketch has them. That ordering is the only one that can
   * put a link in the document, and it is what makes a re-render of the same payload
   * produce the same bytes (DECISIONS.md R-14).
   */
  correctiveActionUrl: z.string().nullable(),
  outcome: reportOutcomeSchema.nullable(),
});
export type ReportNonconformity = z.infer<typeof reportNonconformitySchema>;

/** One answered question, in the checklist table (§4.1 item 6). */
export const reportQuestionSchema = z.object({
  globalOrder: z.number().int(),
  section: sSectionSchema,
  text: z.string(),
  value: responseValueSchema.nullable(),
  marks: z.number().int().nullable(),
  remark: z.string().nullable(),
});
export type ReportQuestion = z.infer<typeof reportQuestionSchema>;

/** One Zone of the report. A zone report has exactly one; a summary has many. */
export const reportZoneSchema = z.object({
  auditZoneId: uuidSchema,
  auditId: uuidSchema,
  auditType: auditTypeSchema,
  /** All from the D6 snapshots, so later edits to the live Zone cannot alter this page. */
  zoneCode: z.string(),
  zoneName: z.string(),
  zoneDescription: z.string().nullable(),
  zoneLeaderName: z.string().nullable(),
  departmentName: z.string().nullable(),
  checklistVersionNo: z.number().int().nullable(),
  auditDate: isoDateTimeSchema.nullable(),
  auditorName: z.string(),
  auditorLoginId: z.string(),
  /** False for a walk-by: no questionnaire, no score, and excluded from every total. */
  scored: z.boolean(),
  totals: scoreTotalsSchema,
  sections: z.array(sectionScoreSchema),
  zoneRemark: z.string().nullable(),
  questions: z.array(reportQuestionSchema),
  good: z.array(reportPhotoSchema),
  nonconformities: z.array(reportNonconformitySchema),
});
export type ReportZone = z.infer<typeof reportZoneSchema>;

/** §10.3-B's closure block. Present on an after-evidence report. */
export const reportClosureSchema = z.object({
  nonconformities: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  notPossible: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  closureRatePercentage: z.number().nullable(),
  /** Mean hours from opening to verification, over verified items. Null when none are. */
  averageClosureHours: z.number().nullable(),
});
export type ReportClosure = z.infer<typeof reportClosureSchema>;

/** §10.3-C's added blocks, on the summary only. */
export const reportSummaryExtrasSchema = z.object({
  /** Descending by percentage; Zones with a null percentage are in neither list. */
  highest: z.array(z.object({ zoneCode: z.string(), zoneName: z.string(), pct: z.number() })),
  lowest: z.array(
    z.object({
      zoneCode: z.string(),
      zoneName: z.string(),
      pct: z.number(),
      /** The S with the lowest percentage in that Zone. Null when none is applicable. */
      weakestSection: sSectionSchema.nullable(),
    }),
  ),
  /** One entry per band, in `RATING_BANDS` order. */
  histogram: z.array(z.object({ token: z.string(), label: z.string(), count: z.number().int() })),
  nonconformitySummary: z.object({
    open: z.number().int().nonnegative(),
    submitted: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    /** Questions raising a nonconformity in more than one selected Zone. */
    recurrent: z.array(
      z.object({
        questionGlobalOrder: z.number().int().nullable(),
        questionText: z.string().nullable(),
        zones: z.number().int(),
      }),
    ),
  }),
});
export type ReportSummaryExtras = z.infer<typeof reportSummaryExtrasSchema>;

/**
 * The frozen payload. Everything the PDF prints, and nothing it has to go and look up.
 *
 * Being self-contained is what makes §10.1's first principle true and what makes the
 * byte-stability test meaningful: the same payload is the same document, whatever has
 * happened to the Zones, the users and the checklists since.
 */
export const reportPayloadSchema = z.object({
  schemaVersion: z.literal(REPORT_PAYLOAD_SCHEMA_VERSION),
  kind: reportKindSchema,
  snapshotId: uuidSchema,
  version: z.number().int().positive(),
  /** Frozen, never `now()` at render time — two renders of one payload are one document. */
  generatedAt: isoDateTimeSchema,
  generatedByName: z.string(),
  unit: z.object({
    id: uuidSchema,
    name: z.string(),
    address: z.string().nullable(),
  }),
  /** Audit-level metadata. Null on a summary spanning several audits. */
  audit: z
    .object({
      id: uuidSchema,
      auditType: auditTypeSchema,
      startedAt: isoDateTimeSchema.nullable(),
      completedAt: isoDateTimeSchema.nullable(),
      auditorName: z.string(),
      auditorLoginId: z.string(),
      startLatitude: z.number().nullable(),
      startLongitude: z.number().nullable(),
      locationSuspicious: z.boolean(),
      /** §4.1 item 4: the AUDITOR VERIFICATION box. Absent on a summary (§4.3 item 9). */
      selfieObjectKey: z.string().nullable(),
    })
    .nullable(),
  zones: z.array(reportZoneSchema),
  /** Summed over the selected Zones only — never a slice of a Unit-wide figure (§10.3). */
  totals: scoreTotalsSchema,
  sections: z.array(sectionScoreSchema),
  /** Summary metadata, when the selection spans several audits or auditors (§4.3 item 2). */
  auditDateRange: z.object({ from: isoDateTimeSchema, to: isoDateTimeSchema }).nullable(),
  auditorNames: z.array(z.string()),
  closure: reportClosureSchema.nullable(),
  summaryExtras: reportSummaryExtrasSchema.nullable(),
  /** Frozen so a report reopened years later keeps the palette it was issued with. */
  bands: z.array(reportBandSchema),
  responseTokens: z.record(
    z.string(),
    z.object({ label: z.string(), color: z.string(), marks: z.number().nullable() }),
  ),
  brand: z.record(z.string(), z.string()),
});
export type ReportPayload = z.infer<typeof reportPayloadSchema>;

// ------------------------------------------------------------------------ the snapshot

export const reportSnapshotSchema = z.object({
  id: uuidSchema,
  kind: reportKindSchema,
  version: z.number().int().positive(),
  supersedesSnapshotId: uuidSchema.nullable(),
  unitId: uuidSchema,
  auditId: uuidSchema.nullable(),
  auditZoneId: uuidSchema.nullable(),
  selectedZoneIds: z.array(uuidSchema).nullable(),
  /**
   * A summary of hand-picked audited Zones: each id is one Zone *of one audit*, so the same
   * Zone may be taken from one audit and not another. Null for every other report.
   */
  selectedAuditZoneIds: z.array(uuidSchema).nullable(),
  /** A summary of one multi-auditor audit: the assignment group whose Zones it combines. */
  assignmentGroupId: uuidSchema.nullable(),
  payloadSchemaVersion: z.number().int().positive(),
  templateVersion: z.string(),
  status: reportStatusSchema,
  pdfObjectKey: z.string().nullable(),
  pdfChecksumSha256: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  generatedByUserId: uuidSchema,
  generatedByName: z.string(),
  generatedAt: isoDateTimeSchema,
  renderedAt: isoDateTimeSchema.nullable(),
  failedReason: z.string().nullable(),
});
export type ReportSnapshot = z.infer<typeof reportSnapshotSchema>;

/**
 * `POST /reports/generate` (§8.9). Super Admin only — a Consultant is refused by
 * `PermissionGuard` because the role holds no `report:generate` cell at all (N5).
 *
 * The kind decides which target field is required, and the union says so rather than
 * leaving three optional fields and a runtime check.
 */
export const generateReportRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('INITIAL_ZONE'), auditZoneId: uuidSchema }),
  z.object({ kind: z.literal('AFTER_EVIDENCE_ZONE'), auditZoneId: uuidSchema }),
  z
    .object({
      kind: z.literal('MULTI_ZONE_SUMMARY'),
      unitId: uuidSchema,
      /**
       * The exact selection by Zone, stored on the snapshot so the summary is reproducible.
       * Each Zone contributes its latest completed audit of it.
       */
      selectedZoneIds: z.array(uuidSchema).max(200).default([]),
      /**
       * The exact selection by audited Zone — a Zone *of a particular audit*. This is how a
       * Super Admin takes Zones 1 and 2 from the first audit of the month and Zones 3, 4
       * and 5 from the second, which a selection by Zone cannot say. Takes precedence over
       * `selectedZoneIds` when both are sent.
       */
      selectedAuditZoneIds: z.array(uuidSchema).min(1).max(200).optional(),
      /**
       * One audit conducted by several auditors together: each selected Zone is taken from
       * the audits of this assignment group, not from the Unit's latest audit of it.
       */
      assignmentGroupId: uuidSchema.optional(),
    })
    .refine((request) => request.selectedZoneIds.length > 0 || request.selectedAuditZoneIds, {
      message: 'Select at least one Zone',
      path: ['selectedZoneIds'],
    }),
]);
export type GenerateReportRequest = z.infer<typeof generateReportRequestSchema>;

export const listReportsQuerySchema = paginationQuerySchema.extend({
  auditId: uuidSchema.optional(),
  auditZoneId: uuidSchema.optional(),
  unitId: uuidSchema.optional(),
  kind: reportKindSchema.optional(),
});
export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;

export const reportDownloadUrlSchema = z.object({
  url: z.string(),
  expiresIn: z.number().int().positive(),
  checksumSha256: z.string().nullable(),
});
export type ReportDownloadUrl = z.infer<typeof reportDownloadUrlSchema>;

// ---------------------------------------------------------------------------- the token

export const REPORT_TOKEN_PURPOSES = ['CORRECTIVE_ACTION', 'VIEW_REPORT'] as const;
export const reportTokenPurposeSchema = z.enum(REPORT_TOKEN_PURPOSES);
export type ReportTokenPurpose = z.infer<typeof reportTokenPurposeSchema>;

/**
 * A minted link, as the token-management screen lists it.
 *
 * The secret is **not** here and cannot be: only its SHA-256 is stored, and the raw value
 * exists in the link alone. A screen that could re-read a token would make the hash
 * pointless.
 */
export const reportAccessTokenSchema = z.object({
  id: uuidSchema,
  purpose: reportTokenPurposeSchema,
  snapshotId: uuidSchema.nullable(),
  correctiveActionId: uuidSchema.nullable(),
  unitId: uuidSchema,
  issuedToUserId: uuidSchema.nullable(),
  issuedToName: z.string().nullable(),
  expiresAt: isoDateTimeSchema,
  maxUses: z.number().int().nullable(),
  useCount: z.number().int().nonnegative(),
  lastUsedAt: isoDateTimeSchema.nullable(),
  lastUsedIp: z.string().nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  revokedByUserId: uuidSchema.nullable(),
  revokeReason: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  /** Derived: expired, revoked or spent. The list renders it rather than re-deriving it. */
  active: z.boolean(),
  /** What the link addresses, so the screen need not join. */
  zoneCode: z.string().nullable(),
  questionGlobalOrder: z.number().int().nullable(),
});
export type ReportAccessToken = z.infer<typeof reportAccessTokenSchema>;

export const revokeTokenRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type RevokeTokenRequest = z.infer<typeof revokeTokenRequestSchema>;

// ------------------------------------------------------- the public, signed-token page

/**
 * `GET /public/corrective-actions/{token}` (§8.8).
 *
 * **One** item and nothing else: no listing, no siblings, no navigation. Everything a
 * person needs to answer this finding and nothing that would let a leaked link walk the
 * rest of the Unit.
 */
export const publicCorrectiveActionSchema = z.object({
  correctiveActionId: uuidSchema,
  status: correctiveActionStatusSchema,
  unitName: z.string(),
  zoneCode: z.string(),
  zoneName: z.string(),
  auditDate: isoDateTimeSchema.nullable(),
  auditorName: z.string(),
  questionGlobalOrder: z.number().int().nullable(),
  questionText: z.string().nullable(),
  section: sSectionSchema.nullable(),
  findingRemark: z.string().nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  /** Short-TTL presigned GET (§12.6), minted after the token check, never before it. */
  beforePhotoUrl: z.string().nullable(),
  /** False once the item is verified: the page then shows the outcome, read-only. */
  submittable: z.boolean(),
  /** The name to prefill Option A with, where the token is bound to a Zone Leader. */
  issuedToName: z.string().nullable(),
  alreadySubmitted: z
    .object({ option: correctiveOptionSchema, submittedAt: isoDateTimeSchema })
    .nullable(),
});
export type PublicCorrectiveAction = z.infer<typeof publicCorrectiveActionSchema>;
