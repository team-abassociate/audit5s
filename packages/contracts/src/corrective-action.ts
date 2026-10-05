import { z } from 'zod';
import { booleanQuery, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from './common';
import {
  auditTypeSchema,
  roleSchema,
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

/**
 * R-38: at most this many overall corrective-action suggestions per Zone, each at most
 * `OVERALL_ACTION_SUGGESTION_MAX_LENGTH` characters. The database holds the first bound.
 */
export const OVERALL_ACTION_SUGGESTION_LIMIT = 20;
export const OVERALL_ACTION_SUGGESTION_MAX_LENGTH = 1000;

/** The auditor's overall suggestions for one Zone, as a request carries them. */
export const overallActionSuggestionsSchema = z
  .array(z.string().trim().min(1).max(OVERALL_ACTION_SUGGESTION_MAX_LENGTH))
  .max(OVERALL_ACTION_SUGGESTION_LIMIT);

export const correctiveActionSchema = z.object({
  id: uuidSchema,
  /**
   * The nonconformity photograph this action answers. Unique: one action per photo.
   *
   * Null on an **overall** action (R-38), which answers the auditor's `suggestion` for the
   * Zone as a whole instead. Exactly one of the two is set.
   */
  evidenceId: uuidSchema.nullable(),
  /** R-38: the auditor's overall suggestion, and its 1-based place in their list. */
  suggestion: z.string().nullable(),
  suggestionNo: z.number().int().positive().nullable(),
  auditId: uuidSchema,
  auditZoneId: uuidSchema,
  unitId: uuidSchema,
  zoneId: uuidSchema,
  /** Null for a walk-by item, which has no questionnaire (§2.7). */
  checklistQuestionId: uuidSchema.nullable(),
  status: correctiveActionStatusSchema,
  assignedZoneLeaderUserId: uuidSchema.nullable(),
  assignedZoneLeaderName: z.string().nullable(),
  /**
   * D3: the Zone's leader now — an account or the name the auditor typed — which is who to
   * chase when the item was not reassigned. Optional so a response from an older API parses.
   */
  zoneLeaderName: z.string().nullable().optional(),
  dueAt: isoDateTimeSchema.nullable(),
  openedAt: isoDateTimeSchema,
  lastSubmittedAt: isoDateTimeSchema.nullable(),
  /** Set on VERIFIED — which is also how an accepted NOT_POSSIBLE ends (§7.3). */
  resolvedAt: isoDateTimeSchema.nullable(),
  /**
   * Who verified it. Null on a Zone Leader's closure nobody has approved (R-23, R-43) — such
   * an action is *closed*, not verified.
   */
  verifiedByUserId: uuidSchema.nullable(),
  /** R-43: the approver's name, for "Approved by …". Optional for an older API. */
  verifiedByName: z.string().nullable().optional(),
  /**
   * R-39: who closed it — the name on the response that settled it, as they gave it
   * (R-22), beside `resolvedAt` for when. Null until the action is VERIFIED. Optional so a
   * response from an API older than this still parses.
   */
  closedByName: z.string().nullable().optional(),
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
  /** R-43: the reviewer's name and role, as a report prints them. Optional for an older API. */
  reviewedByName: z.string().nullable().optional(),
  reviewedByRole: roleSchema.nullable().optional(),
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

export const CORRECTIVE_ACTION_SORTS = ['due', 'age', 'leader'] as const;
export type CorrectiveActionSort = (typeof CORRECTIVE_ACTION_SORTS)[number];
export const CORRECTIVE_ACTION_GROUPS = ['audit', 'leader'] as const;
export type CorrectiveActionGroup = (typeof CORRECTIVE_ACTION_GROUPS)[number];

export const listCorrectiveActionsQuerySchema = paginationQuerySchema.extend({
  unitId: uuidSchema.optional(),
  zoneId: uuidSchema.optional(),
  auditId: uuidSchema.optional(),
  assignedTo: uuidSchema.optional(),
  status: correctiveActionStatusSchema.optional(),
  /** OPEN or REOPENED with `due_at` in the past. */
  overdue: booleanQuery(false),
  /** ACTION_SUBMITTED or NOT_POSSIBLE: waiting on a reviewer's decision (CA4). */
  awaitingReview: booleanQuery(false),
  /**
   * CA10: the order, server-side so a cursor walks it. `due` puts what still awaits an
   * answer first, soonest due first; `age` oldest first; `leader` by who to chase (D3).
   * Absent — and no `group` — the order is the id's, as before (the field app relies on it).
   */
  sort: z.enum(CORRECTIVE_ACTION_SORTS).optional(),
  /**
   * CA10: Unit, then audit (newest first) or Zone and leader, ahead of `sort`, so a group's
   * rows are contiguous and one that runs onto the next page continues there.
   */
  group: z.enum(CORRECTIVE_ACTION_GROUPS).optional(),
});
export type ListCorrectiveActionsQuery = z.infer<typeof listCorrectiveActionsQuerySchema>;

/** `GET /corrective-actions/summary` — the list's filters, without paging or order. */
export const correctiveActionSummaryQuerySchema = listCorrectiveActionsQuerySchema.omit({
  limit: true,
  cursor: true,
  sort: true,
  group: true,
});
export type CorrectiveActionSummaryQuery = z.infer<typeof correctiveActionSummaryQuerySchema>;

const count = z.number().int().nonnegative();

/**
 * CA10: the counts a screen used to take from the rows it had loaded, from the server over
 * every matching row. `overdue` follows the list's `overdue` filter; the groups carry the
 * list's group keys, so a header counts its whole group, not the part on screen.
 */
export const correctiveActionSummarySchema = z.object({
  total: count,
  byStatus: z.record(correctiveActionStatusSchema, count),
  overdue: count,
  /** OPEN or REOPENED, due from now to seven days on. */
  dueWithinWeek: count,
  /** OPEN or REOPENED, raised on a question marked 0 ("Needs improvement"). */
  openNeedsImprovement: count,
  byAudit: z.array(z.object({ unitId: uuidSchema, auditId: uuidSchema, total: count, overdue: count })),
  /** By Zone and who to chase (D3) — the reassigned leader, else the Zone's. */
  byZoneLeader: z.array(
    z.object({
      unitId: uuidSchema,
      zoneId: uuidSchema,
      zoneCode: z.string(),
      zoneName: z.string(),
      leader: z.string().nullable(),
      total: count,
      overdue: count,
    }),
  ),
});
export type CorrectiveActionSummary = z.infer<typeof correctiveActionSummarySchema>;

/**
 * `POST /corrective-actions/{id}/link` (CA9): one more signed link to the action, beside
 * the one printed in its report, which keeps working. Attached to that report, so it is
 * listed and revoked on the Reports page like the printed one.
 *
 * `url` is null on an idempotent replay: the secret is never stored (§10.4), so a retry
 * that the server already answered cannot be shown the link again.
 */
export const correctiveActionLinkSchema = z.object({
  tokenId: uuidSchema,
  snapshotId: uuidSchema,
  url: z.string().nullable(),
});
export type CorrectiveActionLink = z.infer<typeof correctiveActionLinkSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * `POST /corrective-actions/{id}/submissions` (§8.8).
 *
 * Option A needs a name, a description and a **live** after-photo; Option B needs an
 * explanation (CA-2). A missing field is a 422 here, before the database's CHECK has to
 * say the same thing.
 *
 * `afterEvidenceId` is optional in the shape because an **overall** action (R-38) may be
 * answered without a photograph — a smell cannot be photographed. The service still
 * refuses a finding answered without one, and so does the database (0038).
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
    afterEvidenceId: uuidSchema.optional(),
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
