import { z } from 'zod';
import { booleanQuery, clearable, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common';
import { commitEvidenceRequestSchema } from './evidence';
import { roleSchema } from './enums';

/**
 * Kaizen — Leanstack's second module (plans/kaizen-module.md §4, DECISIONS.md R-48).
 *
 * A Zone Leader records an improvement on the client's Kaizen Sheet; their Unit's
 * Coordinator approves it, sends it back, or rejects it. Everything here crosses the
 * API ↔ field app ↔ admin web boundary, so it is defined once, here.
 *
 * Three properties of these shapes carry rules rather than describing them:
 *
 *   - **The number is the server's.** `kaizenNo` appears on the response and nowhere in a
 *     request: the database assigns it on first receipt (`KZ-Z07-001`, a running count per
 *     Unit), so two phones offline at once can never mint the same one. Until it syncs a
 *     device shows "Number on sync".
 *   - **The id is the device's.** A Kaizen is created offline, so `id` is a client-minted
 *     UUIDv7 and `POST /kaizens` is idempotent on it, as an audit or a photo is.
 *   - **A review is the Coordinator's.** Submitting is the author's act and lands in
 *     `audit_log`; `kaizen_review` holds only the reviewer's decisions.
 */

// --------------------------------------------------------------------------- enums

export const KAIZEN_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'SENT_BACK', 'REJECTED'] as const;
export const kaizenStatusSchema = z.enum(KAIZEN_STATUSES);
export type KaizenStatus = z.infer<typeof kaizenStatusSchema>;

/** The Coordinator's three answers to a SUBMITTED Kaizen. Each is also the status it moves to. */
export const KAIZEN_REVIEW_DECISIONS = ['APPROVED', 'SENT_BACK', 'REJECTED'] as const;
export const kaizenReviewDecisionSchema = z.enum(KAIZEN_REVIEW_DECISIONS);
export type KaizenReviewDecision = z.infer<typeof kaizenReviewDecisionSchema>;

/** The Kaizen Sheet's eight wastes, in the sheet's order (its checkboxes are numbered 1–8). */
export const KAIZEN_WASTES = [
  'DEFECTS',
  'OVERPRODUCTION',
  'WAITING_TIME',
  'NON_UTILIZED_TALENT',
  'TRANSPORTATION',
  'INVENTORY',
  'MOTION',
  'EXTRA_PROCESSING',
] as const;
export const kaizenWasteSchema = z.enum(KAIZEN_WASTES);
export type KaizenWaste = z.infer<typeof kaizenWasteSchema>;

export const KAIZEN_PARAMETERS = [
  'PRODUCTIVITY',
  'QUALITY',
  'COST',
  'DELIVERY',
  'SAFETY',
  'MORALE',
] as const;
export const kaizenParameterSchema = z.enum(KAIZEN_PARAMETERS);
export type KaizenParameter = z.infer<typeof kaizenParameterSchema>;

/** The sheet's two photo boxes: G13 before the countermeasure, M13 after it. */
export const KAIZEN_PHOTO_KINDS = ['BEFORE', 'AFTER'] as const;
export const kaizenPhotoKindSchema = z.enum(KAIZEN_PHOTO_KINDS);
export type KaizenPhotoKind = z.infer<typeof kaizenPhotoKindSchema>;

/**
 * What must be filled before a Kaizen can be submitted — the prototype's required steps.
 * The database refuses a non-DRAFT row missing any of them (0044), and the form marks
 * the same steps REQUIRED, so the two cannot disagree.
 */
export const KAIZEN_REQUIRED_FIELDS = [
  'machine',
  'lineArea',
  'implementedOn',
  'teamMembers',
  'theme',
  'problem5w1h',
  'countermeasure',
  'horizontalDeployment',
  'benefits',
  'rootCause4m',
  'ideaBy',
  'implementedBy',
] as const;
export type KaizenRequiredField = (typeof KAIZEN_REQUIRED_FIELDS)[number];

/**
 * What can stop a submit: a required field, or a missing before or after photo (owner,
 * 2026-10-10, R-49). `missingKaizenItems` lists them, so the form and the server agree.
 */
export type KaizenMissingItem = KaizenRequiredField | 'beforePhoto' | 'afterPhoto';

// ------------------------------------------------------------------- the record

/** `YYYY-MM-DD`, a calendar date with no time or zone: the day it was implemented. */
export const isoDateSchema = z.iso.date();

/** Rupees, two decimals, `numeric(14,2)`. Rendered `₹1,08,000` (en-IN) by the clients. */
export const rupeesSchema = z.number().nonnegative().max(999_999_999_999.99);

const shortText = z.string().trim().max(200);
const longText = z.string().trim().max(4000);

export const kaizenPhotoSchema = z.object({
  id: uuidSchema,
  kaizenId: uuidSchema,
  kind: kaizenPhotoKindSchema,
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  checksumSha256: z.string(),
  capturedAt: isoDateTimeSchema,
  /** Null until `commit` confirms the object arrived. */
  uploadedAt: isoDateTimeSchema.nullable(),
  /** False ⇒ chosen from the gallery, which Kaizen allows (R-48). */
  isLiveCapture: z.boolean(),
  /**
   * A short-TTL presigned GET (≤ 5 min, §12.6), present on `GET /kaizens/{id}` once the
   * photo is uploaded. Null in lists and before upload: media never transits the API.
   */
  viewUrl: z.string().nullable(),
});
export type KaizenPhoto = z.infer<typeof kaizenPhotoSchema>;

export const kaizenReviewSchema = z.object({
  id: uuidSchema,
  kaizenId: uuidSchema,
  reviewerUserId: uuidSchema,
  /** Snapshotted at review time: a Zone Leader cannot read the Coordinator's user row. */
  reviewerName: z.string(),
  reviewerRole: roleSchema,
  decision: kaizenReviewDecisionSchema,
  /** Required for SENT_BACK and REJECTED; optional for APPROVED. */
  comment: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type KaizenReview = z.infer<typeof kaizenReviewSchema>;

export const kaizenSchema = z.object({
  id: uuidSchema,
  /** `KZ-Z07-001`: the Zone's code and the Unit's running count. Server-assigned. */
  kaizenNo: z.string(),
  unitId: uuidSchema,
  unitName: z.string(),
  zoneId: uuidSchema,
  zoneCode: z.string(),
  zoneName: z.string(),
  /** The Zone's `department_hint`, trimmed. Null ⇒ "No department". */
  department: z.string().nullable(),
  authorUserId: uuidSchema,
  /** Snapshotted at creation, so a Consultant or Coordinator never joins `user` for it. */
  authorName: z.string(),

  // The sheet. Nullable because a DRAFT may be half filled; submit requires
  // KAIZEN_REQUIRED_FIELDS.
  machine: z.string().nullable(),
  lineArea: z.string().nullable(),
  implementedOn: isoDateSchema.nullable(),
  teamMembers: z.string().nullable(),
  theme: z.string().nullable(),
  target: z.string().nullable(),
  problem5w1h: z.string().nullable(),
  rootCause4m: z.string().nullable(),
  analysis7qc: z.string().nullable(),
  countermeasure: z.string().nullable(),
  wastes: z.array(kaizenWasteSchema),
  parameters: z.array(kaizenParameterSchema),
  horizontalDeployment: z.boolean().nullable(),
  benefits: z.string().nullable(),
  annualSaving: rupeesSchema.nullable(),
  ideaBy: z.string().nullable(),
  implementedBy: z.string().nullable(),

  status: kaizenStatusSchema,
  /** First submission. A resubmission after SENT_BACK does not move it. */
  submittedAt: isoDateTimeSchema.nullable(),
  /** The latest review, so a card can show the Coordinator's reason without a second call. */
  latestReview: kaizenReviewSchema.nullable(),
  beforePhoto: kaizenPhotoSchema.nullable(),
  afterPhoto: kaizenPhotoSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Kaizen = z.infer<typeof kaizenSchema>;

/** `GET /kaizens/{id}`: the record and its whole review history, oldest first. */
export const kaizenDetailSchema = kaizenSchema.extend({
  reviews: z.array(kaizenReviewSchema),
});
export type KaizenDetail = z.infer<typeof kaizenDetailSchema>;

// ---------------------------------------------------------------------- requests

/** The sheet's fields as a writer sends them. Every one optional: a draft is saved per field. */
export const kaizenFieldsSchema = z.object({
  machine: clearable(shortText),
  lineArea: clearable(shortText),
  implementedOn: clearable(isoDateSchema),
  teamMembers: clearable(longText),
  theme: clearable(z.string().trim().max(300)),
  target: clearable(z.string().trim().max(300)),
  problem5w1h: clearable(longText),
  rootCause4m: clearable(longText),
  analysis7qc: clearable(longText),
  countermeasure: clearable(longText),
  wastes: z.array(kaizenWasteSchema).max(KAIZEN_WASTES.length).optional(),
  parameters: z.array(kaizenParameterSchema).max(KAIZEN_PARAMETERS.length).optional(),
  horizontalDeployment: z.boolean().nullable().optional(),
  benefits: clearable(longText),
  annualSaving: rupeesSchema.nullable().optional(),
  ideaBy: clearable(shortText),
  implementedBy: clearable(shortText),
});
export type KaizenFields = z.infer<typeof kaizenFieldsSchema>;

/**
 * `POST /kaizens`, and the `kaizen:upsert` sync payload.
 *
 * Idempotent on `id`: the first copy creates the DRAFT (and its number), a later one
 * updates it while it is still DRAFT or SENT_BACK. The outbox replaces an unsynced
 * payload whole, so a sync upsert always carries every field the device holds.
 * The Zone is fixed at creation, because the number carries its code.
 */
export const createKaizenRequestSchema = kaizenFieldsSchema.extend({
  id: uuidSchema,
  zoneId: uuidSchema,
});
export type CreateKaizenRequest = z.infer<typeof createKaizenRequestSchema>;

/** `PATCH /kaizens/{id}`: DRAFT or SENT_BACK, author only. */
export const patchKaizenRequestSchema = kaizenFieldsSchema.refine(
  (patch) => Object.values(patch).some((value) => value !== undefined),
  { message: 'Nothing to change' },
);
export type PatchKaizenRequest = z.infer<typeof patchKaizenRequestSchema>;

/**
 * `POST /kaizens/{id}/submit`, and the `kaizen_submission:submit` sync payload (whose
 * `entityId` is `submissionId`).
 *
 * `submissionId` is minted by the device when Submit is tapped. A replay of the same
 * submission is a DUPLICATE; a resubmission after SENT_BACK is a new id. Without it a
 * submission replayed days late could resubmit a Kaizen the Coordinator has since sent
 * back, with the author's rework still unsaved.
 */
export const submitKaizenRequestSchema = z.object({
  submissionId: uuidSchema,
});
export type SubmitKaizenRequest = z.infer<typeof submitKaizenRequestSchema>;

export const kaizenSubmissionSyncPayloadSchema = submitKaizenRequestSchema.extend({
  kaizenId: uuidSchema,
});
export type KaizenSubmissionSyncPayload = z.infer<typeof kaizenSubmissionSyncPayloadSchema>;

/** `POST /kaizens/{id}/review`. Online only: a Coordinator records nothing offline (R-24). */
export const reviewKaizenRequestSchema = z
  .object({
    decision: kaizenReviewDecisionSchema,
    comment: clearable(z.string().trim().max(2000)),
  })
  .refine((review) => review.decision === 'APPROVED' || !!review.comment, {
    message: 'A reason is required to send back or reject a Kaizen',
    path: ['comment'],
  });
export type ReviewKaizenRequest = z.infer<typeof reviewKaizenRequestSchema>;

export const KAIZEN_SORTS = ['recent', 'saving'] as const;

/** `GET /kaizens`. Scope is the server's (AZ-2): `unitId` and `zoneId` narrow, never widen. */
export const listKaizensQuerySchema = paginationQuerySchema.extend({
  unitId: uuidSchema.optional(),
  zoneId: uuidSchema.optional(),
  status: kaizenStatusSchema.optional(),
  /** The caller's own Kaizens only. Implied for a Zone Leader, whose scope is their own. */
  mine: booleanQuery(false),
  /** First submitted on or after this instant ("last 30 days"). */
  submittedFrom: isoDateTimeSchema.optional(),
  /** `recent`: newest first. `saving`: largest `annualSaving` first (Top 3 approved). */
  sort: z.enum(KAIZEN_SORTS).default('recent'),
});
export type ListKaizensQuery = z.infer<typeof listKaizensQuerySchema>;

// ------------------------------------------------------------------------ photos

/**
 * `POST /kaizens/{id}/photos/upload-intent`, and the `kaizen_photo:upsert` sync payload.
 *
 * The evidence pipeline's two-phase upload (§9.4) for Kaizen's own photo list: the
 * device downscales to ≤1920 px JPEG and strips EXIF, the server mints a
 * content-addressed key and a presigned PUT, the bytes go straight to storage, and
 * `commit` confirms. Idempotent on `id`. A Kaizen holds one live photo per kind;
 * replacing one is `delete` of the old then an intent for the new.
 */
export const kaizenPhotoUploadIntentRequestSchema = z.object({
  id: uuidSchema,
  kaizenId: uuidSchema,
  kind: kaizenPhotoKindSchema,
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(15 * 1024 * 1024),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex SHA-256'),
  capturedAt: isoDateTimeSchema,
  isLiveCapture: z.boolean(),
});
export type KaizenPhotoUploadIntentRequest = z.infer<typeof kaizenPhotoUploadIntentRequestSchema>;

export const kaizenPhotoUploadIntentResponseSchema = z.object({
  photoId: uuidSchema,
  objectKey: z.string(),
  uploadUrl: z.string(),
  requiredHeaders: z.record(z.string(), z.string()),
  expiresIn: z.number().int().positive(),
  alreadyExists: z.boolean(),
});
export type KaizenPhotoUploadIntentResponse = z.infer<typeof kaizenPhotoUploadIntentResponseSchema>;

/** `POST /kaizens/{id}/photos/{photoId}/commit`, and `kaizen_photo:commit`. Same checks as evidence. */
export const commitKaizenPhotoRequestSchema = commitEvidenceRequestSchema;
export type CommitKaizenPhotoRequest = z.infer<typeof commitKaizenPhotoRequestSchema>;

// --------------------------------------------------------------- dashboard (§4.7)

export const KAIZEN_DASHBOARD_PERIODS = ['overall', 'year', 'month'] as const;
export const kaizenDashboardPeriodSchema = z.enum(KAIZEN_DASHBOARD_PERIODS);
export type KaizenDashboardPeriod = z.infer<typeof kaizenDashboardPeriodSchema>;

/** `GET /kaizens/dashboard`. Scope-filtered like every read; `unitId` narrows (AZ-2). */
export const kaizenDashboardQuerySchema = z.object({
  period: kaizenDashboardPeriodSchema.default('overall'),
  unitId: uuidSchema.optional(),
});
export type KaizenDashboardQuery = z.infer<typeof kaizenDashboardQuerySchema>;

/**
 * A. The KPI card. Every count is of Kaizens **first submitted in the period**; DRAFT is
 * never counted anywhere. Ratios are exact percentages (0–100); the clients show them
 * truncated to one decimal, never rounded up (R-45), and null as "—".
 */
export const kaizenKpiSchema = z.object({
  submitted: z.number().int().nonnegative(),
  awaitingReview: z.number().int().nonnegative(),
  sentBack: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  /** rejected ÷ submitted × 100. Null when nothing was submitted. */
  rejectionRatioPct: z.number().min(0).max(100).nullable(),
  /** approved ÷ submitted × 100. Null when nothing was submitted. */
  acceptanceRatioPct: z.number().min(0).max(100).nullable(),
});
export type KaizenKpi = z.infer<typeof kaizenKpiSchema>;

/** B. The funnel's stages, each a subset of the one before, so it always narrows. */
export const KAIZEN_FUNNEL_STAGES = [
  'SUBMITTED',
  /** Has at least one review decision, now or before. */
  'REVIEWED',
  'APPROVED',
  /** Approved and `annualSaving > 0`. */
  'APPROVED_WITH_SAVING',
] as const;
export const kaizenFunnelStageSchema = z.enum(KAIZEN_FUNNEL_STAGES);
export type KaizenFunnelStage = z.infer<typeof kaizenFunnelStageSchema>;

export const kaizenFunnelSchema = z.array(
  z.object({
    stage: kaizenFunnelStageSchema,
    count: z.number().int().nonnegative(),
    /** count ÷ Submitted × 100; null when nothing was submitted. Also the stage's width. */
    pctOfSubmitted: z.number().min(0).max(100).nullable(),
  }),
);
export type KaizenFunnel = z.infer<typeof kaizenFunnelSchema>;

/** `YYYY-MM`, a calendar month in India Standard Time, as every screen reads dates. */
export const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');

/**
 * C. The last 6 calendar months, oldest first, the current one included. A month with no
 * Kaizens is present with zeros, never missing. Independent of `period`.
 */
export const kaizenTrendMonthSchema = z.object({
  month: yearMonthSchema,
  /** First submitted that month. */
  submitted: z.number().int().nonnegative(),
  /** Approved that month, by review date. */
  approved: z.number().int().nonnegative(),
});
export type KaizenTrendMonth = z.infer<typeof kaizenTrendMonthSchema>;

/**
 * D. One department's line on "Top 5 trend – Departments". `monthly` follows the trend's
 * six months, index for index. Grouped by the Zone's `department_hint`, trimmed and
 * case-folded; `label` is its most common spelling, null for Zones with none.
 */
export const kaizenDepartmentSeriesSchema = z.object({
  /** The case-folded group key; `''` for "No department". Stable across periods. */
  key: z.string(),
  label: z.string().nullable(),
  monthly: z.array(z.number().int().nonnegative()).length(6),
  total: z.number().int().nonnegative(),
});
export type KaizenDepartmentSeries = z.infer<typeof kaizenDepartmentSeriesSchema>;

export const kaizenDashboardSchema = z.object({
  period: kaizenDashboardPeriodSchema,
  serverTime: isoDateTimeSchema,
  kpi: kaizenKpiSchema,
  funnel: kaizenFunnelSchema,
  trend: z.array(kaizenTrendMonthSchema).length(6),
  /** Both toggles at once, so switching Submitted ↔ Approved is not a round trip. At most 5 each. */
  topDepartments: z.object({
    submitted: z.array(kaizenDepartmentSeriesSchema).max(5),
    approved: z.array(kaizenDepartmentSeriesSchema).max(5),
  }),
});
export type KaizenDashboard = z.infer<typeof kaizenDashboardSchema>;

// ------------------------------------------------------------------------ analysis

export const KAIZEN_ANALYSIS_GROUPINGS = ['department', 'zone'] as const;

/** `GET /kaizens/analysis`: the department-wise / zone-wise table under the charts. */
export const kaizenAnalysisQuerySchema = z.object({
  by: z.enum(KAIZEN_ANALYSIS_GROUPINGS).default('department'),
  period: kaizenDashboardPeriodSchema.default('overall'),
  unitId: uuidSchema.optional(),
});
export type KaizenAnalysisQuery = z.infer<typeof kaizenAnalysisQuerySchema>;

export const kaizenAnalysisRowSchema = z.object({
  /** Department key (as in the dashboard) or Zone id. */
  key: z.string(),
  /** Department label or Zone name; null ⇒ "No department". */
  label: z.string().nullable(),
  /** The Zone's code when `by=zone`. */
  zoneCode: z.string().nullable(),
  /** Submitted, any status but DRAFT. */
  total: z.number().int().nonnegative(),
  approved: z.number().int().nonnegative(),
  /** Awaiting review (SUBMITTED). */
  pending: z.number().int().nonnegative(),
  /** Sent back or rejected — returned to the author either way. */
  returned: z.number().int().nonnegative(),
  approvedSaving: rupeesSchema,
});
export type KaizenAnalysisRow = z.infer<typeof kaizenAnalysisRowSchema>;

export const kaizenAnalysisSchema = z.object({
  by: z.enum(KAIZEN_ANALYSIS_GROUPINGS),
  period: kaizenDashboardPeriodSchema,
  rows: z.array(kaizenAnalysisRowSchema),
});
export type KaizenAnalysis = z.infer<typeof kaizenAnalysisSchema>;

// -------------------------------------------------------------------- export (§4.6)

export const KAIZEN_EXPORT_STATUSES = ['QUEUED', 'READY', 'FAILED'] as const;
export const kaizenExportStatusSchema = z.enum(KAIZEN_EXPORT_STATUSES);
export type KaizenExportStatus = z.infer<typeof kaizenExportStatusSchema>;

/**
 * `POST /kaizens/{id}/export` answers 202 with this; `GET /kaizens/{id}/export/{exportId}`
 * answers the same shape until it is READY. The file is the Kaizen Sheet as a PDF
 * (owner, 2026-10-07: redesigned, no Excel), named "{Unit} - Zone {n} {Zone name} - {date}.pdf".
 */
export const kaizenExportSchema = z.object({
  exportId: uuidSchema,
  status: kaizenExportStatusSchema,
  fileName: z.string(),
  /** Short-TTL presigned GET, present when READY. */
  downloadUrl: z.string().nullable(),
  expiresIn: z.number().int().positive().nullable(),
});
export type KaizenExport = z.infer<typeof kaizenExportSchema>;
