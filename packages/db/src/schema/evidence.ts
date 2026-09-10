import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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
  evidenceClassificationEnum,
  evidenceKindEnum,
  locationProviderEnum,
  responseValueEnum,
  syncStateEnum,
} from './enums';
import { audits, auditZones, questionResponses } from './audits';
import { devices } from './access';
import { users } from './identity';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * Evidence (ARCHITECTURE.md §5.6).
 *
 * The rules that matter here are in migration 0007 as constraints and a trigger, not in
 * this file, and for the usual reason: an ORM-level rule is advice. The two partial unique
 * indexes are declared below because Drizzle can express them and a reader should see them
 * beside the column they constrain — but they are enforced because the database holds
 * them, which is what makes a duplicated sync unable to produce two flagged photos.
 *
 * `id` has no default. Like `audit`, `audit_zone` and `question_response`, it is the
 * device's UUIDv7 (D12): a row the server keyed for itself could not be reconciled with
 * the device row that authored it, and the retried upload intent could not find it.
 */
export const evidence = pgTable(
  'evidence',
  {
    id: uuid('id').primaryKey(),
    kind: evidenceKindEnum('kind').notNull(),
    auditId: uuid('audit_id')
      .notNull()
      .references(() => audits.id, { onDelete: 'restrict' }),
    /** Null only for the audit-level selfie. */
    auditZoneId: uuid('audit_zone_id').references(() => auditZones.id, { onDelete: 'restrict' }),
    /** The link E-1 classifies from, and E-2 reclassifies through. */
    questionResponseId: uuid('question_response_id').references(() => questionResponses.id, {
      onDelete: 'restrict',
    }),
    /** The FK arrives with `corrective_action_submission` in Phase 6. */
    correctiveActionSubmissionId: uuid('corrective_action_submission_id'),

    objectKey: text('object_key').notNull(),
    thumbnailObjectKey: text('thumbnail_object_key'),
    contentType: text('content_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    checksumSha256: text('checksum_sha256').notNull(),

    localDeviceId: uuid('local_device_id').references(() => devices.id, { onDelete: 'restrict' }),
    localFileUri: text('local_file_uri'),

    scoreAtCapture: responseValueEnum('score_at_capture'),
    classification: evidenceClassificationEnum('classification').notNull().default('NEUTRAL'),
    remark: text('remark'),
    isSummaryFlagged: boolean('is_summary_flagged').notNull().default(false),

    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    accuracyM: numeric('accuracy_m', { precision: 8, scale: 2 }),
    locationProvider: locationProviderEnum('location_provider'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    syncState: syncStateEnum('sync_state').notNull().default('SYNCING'),
    /** §12.10: recorded and shown to reviewers, never described as proof. */
    isLiveCapture: boolean('is_live_capture').notNull().default(false),

    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: uuid('deleted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    /** R-5: the erasure path overwrites the object and keeps the row. */
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    redactedByUserId: uuid('redacted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    redactionReason: text('redaction_reason'),

    ...timestamps,
  },
  (table) => [
    uniqueIndex('evidence_object_key_key').on(table.objectKey),
    index('evidence_zone_classification_idx')
      .on(table.auditZoneId, table.classification)
      .where(sql`deleted_at IS NULL`),
    index('evidence_question_response_idx').on(table.questionResponseId),
    index('evidence_audit_kind_idx').on(table.auditId, table.kind),
    index('evidence_checksum_idx').on(table.checksumSha256, table.auditId),

    // §5.6's enforcement of "one optional flagged GOOD and one optional flagged
    // NONCONFORMITY per Zone". A duplicated sync cannot get past these.
    uniqueIndex('evidence_one_flagged_good_per_zone')
      .on(table.auditZoneId)
      .where(sql`is_summary_flagged AND classification = 'GOOD' AND deleted_at IS NULL`),
    uniqueIndex('evidence_one_flagged_nonconformity_per_zone')
      .on(table.auditZoneId)
      .where(sql`is_summary_flagged AND classification = 'NONCONFORMITY' AND deleted_at IS NULL`),

    /** Invariant E-3. */
    check(
      'evidence_e3_summary_flag',
      sql`NOT is_summary_flagged OR classification IN ('GOOD','NONCONFORMITY')`,
    ),
  ],
);
