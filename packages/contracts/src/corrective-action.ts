import { z } from 'zod';
import { booleanQuery, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common';
import {
  auditTypeSchema,
  correctiveActionStatusSchema,
  correctiveOptionSchema,
  responseValueSchema,
  sSectionSchema,
} from './enums';

/**
 * Corrective actions (ARCHITECTURE.md §2.8, §5.7, §7.3, §8.8).
 *
 * One action per nonconformity photograph, each an independent aggregate. The shapes carry
 * the rule that makes "3 of 5 submitted, 2 next week" safe: a submission names exactly one
 * action in its path, and no request shape here addresses more than one.
 */

export const correctiveActionSchema = z.object({
  id: uuidSchema,
  /** The nonconformity photograph this action answers. Unique: one action per photo. */
  evidenceId: uuidSchema,
  auditId: uuidSchema,
  auditZoneId: uuidSchema,
  unitId: uuidSchema,
  zoneId: uuidSchema,
  /** Null for a walk-by item, which has no questionnaire (§2.7). */
  checklistQuestionId: uuidSchema.nullable(),
  status: correctiveActionStatusSchema,
  assignedZoneLeaderUserId: uuidSchema.nullable(),
  assignedZoneLeaderName: z.string().nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  openedAt: isoDateTimeSchema,
  lastSubmittedAt: isoDateTimeSchema.nullable(),
  /** Set on VERIFIED — which is also how an accepted NOT_POSSIBLE ends (§7.3). */
  resolvedAt: isoDateTimeSchema.nullable(),
  verifiedByUserId: uuidSchema.nullable(),
  reopenCount: z.number().int().nonnegative(),
  /** Optimistic lock (§15.8): the second of two concurrent reviewers gets VERSION_CONFLICT. */
  version: z.number().int().positive(),

  // What the item *is*, from the audit's own snapshots (D6), so no screen joins for it.
  auditType: auditTypeSchema,
  /**
   * Who conducted the audit that raised this item.
   *
   * A Super Admin reading a list of corrective actions is reading findings from several
   * auditors at once, and "which audit is this from" is the first question they ask of any
   * of them. The audit's id answers it only to someone willing to go and look it up.
   *
   * The name comes from the same narrow definer function the public page uses, so a Zone
   * Leader holding a signed link — who cannot read the Consultant's `user` row — still
   * gets a name rather than an empty column. Null only when that read finds nothing.
   */
  auditorUserId: uuidSchema,
  auditorName: z.string().nullable(),
  zoneCode: z.string(),
  zoneName: z.string(),
  section: sSectionSchema.nullable(),
  questionGlobalOrder: z.number().int().nullable(),
  questionText: z.string().nullable(),
  scoreAtCapture: responseValueSchema.nullable(),
  /** The auditor's remark on the before photo. */
  findingRemark: z.string().nullable(),
  auditCompletedAt: isoDateTimeSchema.nullable(),
});
export type CorrectiveAction = z.infer<typeof correctiveActionSchema>;

export const SUBMISSION_CHANNELS = ['MOBILE', 'WEB_TOKEN', 'WEB_SESSION'] as const;
export const submissionChannelSchema = z.enum(SUBMISSION_CHANNELS);
export type SubmissionChannel = z.infer<typeof submissionChannelSchema>;

export const REVIEW_OUTCOMES = ['VERIFIED', 'REOPENED'] as const;
export const reviewOutcomeSchema = z.enum(REVIEW_OUTCOMES);
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

/** One attempt (CA-1). Never updated except to record its review, never deleted. */
export const correctiveActionSubmissionSchema = z.object({
  id: uuidSchema,
  correctiveActionId: uuidSchema,
  attemptNo: z.number().int().positive(),
  option: correctiveOptionSchema,
  submittedByUserId: uuidSchema,
  submittedByName: z.string(),
  description: z.string().nullable(),
  explanation: z.string().nullable(),
  afterEvidenceId: uuidSchema.nullable(),
  submittedVia: submissionChannelSchema,
  reviewOutcome: reviewOutcomeSchema.nullable(),
  reviewedByUserId: uuidSchema.nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  reviewComment: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type CorrectiveActionSubmission = z.infer<typeof correctiveActionSubmissionSchema>;

/** `GET /corrective-actions/{id}` — "includes the full submission history" (§8.8). */
export const correctiveActionDetailSchema = correctiveActionSchema.extend({
  submissions: z.array(correctiveActionSubmissionSchema),
});
export type CorrectiveActionDetail = z.infer<typeof correctiveActionDetailSchema>;

export const listCorrectiveActionsQuerySchema = paginationQuerySchema.extend({
  unitId: uuidSchema.optional(),
  zoneId: uuidSchema.optional(),
  auditId: uuidSchema.optional(),
  assignedTo: uuidSchema.optional(),
  status: correctiveActionStatusSchema.optional(),
  /** OPEN or REOPENED with `due_at` in the past. */
  overdue: booleanQuery(false),
});
export type ListCorrectiveActionsQuery = z.infer<typeof listCorrectiveActionsQuerySchema>;

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * `POST /corrective-actions/{id}/submissions` (§8.8).
 *
 * Option A needs a name, a description and a **live** after-photo; Option B needs an
 * explanation (CA-2). A missing field is a 422 here, before the database's CHECK has to
 * say the same thing.
 *
 * `id` is optional on the HTTP route, where `Idempotency-Key` does the deduplication, and
 * always present from a device: the outbox mints it, it names the after-photo's object key
 * (§5.6), and it is what makes a replayed sync item a duplicate rather than attempt + 1.
 */
export const submitCorrectiveActionRequestSchema = z.discriminatedUnion('option', [
  z.object({
    option: z.literal('COMPLETED'),
    id: uuidSchema.optional(),
    submittedByName: text(200),
    description: text(4000),
    afterEvidenceId: uuidSchema,
  }),
  z.object({
    option: z.literal('NOT_POSSIBLE'),
    id: uuidSchema.optional(),
    /**
     * Who is answering. Required through a signed link, where the answerer may have no
     * account (R-22); a signed-in user may omit it and their account's name is recorded.
     */
    submittedByName: text(200).optional(),
    explanation: text(4000),
  }),
]);
export type SubmitCorrectiveActionRequest = z.infer<typeof submitCorrectiveActionRequestSchema>;

export const verifyCorrectiveActionRequestSchema = z.object({
  comment: z.string().trim().max(2000).optional(),
  /** The version the reviewer read. A stale one is 409 VERSION_CONFLICT (§15.8). */
  version: z.number().int().positive().optional(),
});
export type VerifyCorrectiveActionRequest = z.infer<typeof verifyCorrectiveActionRequestSchema>;

export const reopenCorrectiveActionRequestSchema = z.object({
  reason: text(2000),
  version: z.number().int().positive().optional(),
});
export type ReopenCorrectiveActionRequest = z.infer<typeof reopenCorrectiveActionRequestSchema>;

export const reassignCorrectiveActionRequestSchema = z.object({
  zoneLeaderUserId: uuidSchema,
});
export type ReassignCorrectiveActionRequest = z.infer<
  typeof reassignCorrectiveActionRequestSchema
>;
