import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  kaizenParameterEnum,
  kaizenPhotoKindEnum,
  kaizenReviewDecisionEnum,
  kaizenStatusEnum,
  kaizenWasteEnum,
  roleEnum,
} from './enums';
import { units, users } from './identity';
import { zones } from './zones';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * Kaizen (DECISIONS.md R-48, plans/kaizen-module.md §4.1).
 *
 * The numbering trigger, the state machine's database half, the photo freeze and the
 * policies live in migration 0044. The indexes below are declared so a reader sees them
 * beside the columns; they are enforced because the database holds them.
 */
export const kaizens = pgTable(
  'kaizen',
  {
    /** Device-minted, so a create replayed through the outbox is the same row. */
    id: uuid('id').primaryKey(),
    /** Set from the Zone by the numbering trigger; a client cannot choose it. */
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    zoneId: uuid('zone_id')
      .notNull()
      .references(() => zones.id, { onDelete: 'restrict' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    authorName: text('author_name').notNull(),
    /**
     * Written by 0044's numbering trigger, which overwrites whatever an insert carries.
     * The client-side placeholder only lets an insert type-check without one.
     */
    kaizenSeq: integer('kaizen_seq').notNull().$defaultFn(() => 0),
    kaizenNo: text('kaizen_no').notNull().$defaultFn(() => ''),

    machine: text('machine'),
    lineArea: text('line_area'),
    implementedOn: date('implemented_on', { mode: 'string' }),
    teamMembers: text('team_members'),
    theme: text('theme'),
    target: text('target'),
    problem5w1h: text('problem_5w1h'),
    rootCause4m: text('root_cause_4m'),
    analysis7qc: text('analysis_7qc'),
    countermeasure: text('countermeasure'),
    wastes: kaizenWasteEnum('wastes').array().notNull().default(sql`'{}'`),
    parameters: kaizenParameterEnum('parameters').array().notNull().default(sql`'{}'`),
    horizontalDeployment: boolean('horizontal_deployment'),
    benefits: text('benefits'),
    annualSaving: numeric('annual_saving', { precision: 14, scale: 2 }),
    ideaBy: text('idea_by'),
    implementedBy: text('implemented_by'),

    status: kaizenStatusEnum('status').notNull().default('DRAFT'),
    /** First submission; a resubmission does not move it. Dashboard periods count by it. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    lastSubmissionId: uuid('last_submission_id'),
    /** Set when the author discards the DRAFT (R-49, 0045). Left out of every list; never deleted. */
    discardedAt: timestamp('discarded_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('kaizen_unit_seq_key').on(table.unitId, table.kaizenSeq),
    uniqueIndex('kaizen_unit_no_key').on(table.unitId, table.kaizenNo),
    index('kaizen_unit_status_submitted_idx').on(table.unitId, table.status, table.submittedAt),
    index('kaizen_author_idx').on(table.authorUserId, table.createdAt.desc()),
    index('kaizen_zone_idx').on(table.zoneId),
  ],
);

/** A reviewer's decision. Append-only (0044's trigger). */
export const kaizenReviews = pgTable(
  'kaizen_review',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    kaizenId: uuid('kaizen_id')
      .notNull()
      .references(() => kaizens.id, { onDelete: 'restrict' }),
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    reviewerName: text('reviewer_name').notNull(),
    reviewerRole: roleEnum('reviewer_role').notNull(),
    decision: kaizenReviewDecisionEnum('decision').notNull(),
    /** Required for SENT_BACK and REJECTED (a CHECK). */
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('kaizen_review_kaizen_idx').on(table.kaizenId, table.createdAt),
    index('kaizen_review_decision_created_idx').on(table.decision, table.createdAt),
  ],
);

/** The sheet's before and after photographs. Kaizen's own list; the evidence pipeline's upload. */
export const kaizenPhotos = pgTable(
  'kaizen_photo',
  {
    id: uuid('id').primaryKey(),
    kaizenId: uuid('kaizen_id')
      .notNull()
      .references(() => kaizens.id, { onDelete: 'restrict' }),
    kind: kaizenPhotoKindEnum('kind').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    checksumSha256: text('checksum_sha256').notNull(),
    storedChecksumSha256: text('stored_checksum_sha256'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    isLiveCapture: boolean('is_live_capture').notNull().default(false),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('kaizen_photo_object_key_key').on(table.objectKey),
    uniqueIndex('kaizen_photo_one_live_per_kind')
      .on(table.kaizenId, table.kind)
      .where(sql`deleted_at IS NULL`),
  ],
);
