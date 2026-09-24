import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { ReportPayload } from '@audit5s/contracts';
import { audits, auditZones } from './audits';
import { correctiveActions } from './corrective-actions';
import { reportKindEnum, reportStatusEnum } from './enums';
import { units, users } from './identity';

/**
 * Reporting (ARCHITECTURE.md §5.8, PART 10).
 *
 * RS-1's immutability trigger, the version uniqueness and the token audience CHECKs live
 * in migration 0010. The indexes below are declared so a reader sees them beside the
 * columns; they are enforced because the database holds them.
 */
export const reportSnapshots = pgTable(
  'report_snapshot',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    kind: reportKindEnum('kind').notNull(),
    /** 1, 2, 3… never overwritten (RS-1). Regeneration inserts; it does not rewrite. */
    version: integer('version').notNull(),
    supersedesSnapshotId: uuid('supersedes_snapshot_id').references(
      (): AnyPgColumn => reportSnapshots.id,
      { onDelete: 'restrict' },
    ),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    auditId: uuid('audit_id').references(() => audits.id, { onDelete: 'restrict' }),
    auditZoneId: uuid('audit_zone_id').references(() => auditZones.id, { onDelete: 'restrict' }),
    /** The exact Zone selection of a summary, so its scope is reproducible (§10.3-C). */
    selectedZoneIds: uuid('selected_zone_ids').array(),
    /** A summary of hand-picked audited Zones, possibly from several audits (0033). */
    selectedAuditZoneIds: uuid('selected_audit_zone_ids').array(),
    /** A summary of one multi-auditor audit: the assignment group it combines (0029). */
    assignmentGroupId: uuid('assignment_group_id'),
    /** THE frozen data. A report renders from this and never from live tables (§10.1). */
    payload: jsonb('payload').$type<ReportPayload>().notNull(),
    payloadSchemaVersion: integer('payload_schema_version').notNull().default(1),
    templateVersion: text('template_version').notNull(),
    status: reportStatusEnum('status').notNull().default('QUEUED'),
    pdfObjectKey: text('pdf_object_key'),
    pdfChecksumSha256: text('pdf_checksum_sha256'),
    pageCount: integer('page_count'),
    generatedByUserId: uuid('generated_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    renderedAt: timestamp('rendered_at', { withTimezone: true }),
    failedReason: text('failed_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('report_snapshot_zone_version_key')
      .on(table.auditZoneId, table.kind, table.version)
      .where(sql`audit_zone_id IS NOT NULL`),
    index('report_snapshot_audit_idx').on(table.auditId, table.kind, table.version),
    index('report_snapshot_unit_idx').on(table.unitId, table.generatedAt),
    index('report_snapshot_status_idx').on(table.status),
  ],
);

/**
 * A signed link (§5.8, §10.4).
 *
 * `tokenHash` is the SHA-256 of a 256-bit random secret that exists **only inside the
 * link**. Nothing here can reproduce it, which is what makes an invalid token and an
 * expired one indistinguishable from outside — §10.4's "no enumeration".
 */
export const reportAccessTokens = pgTable(
  'report_access_token',
  {
    /** = the JTI embedded in the link's path. A revoke names this, never the secret. */
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose').notNull(),
    snapshotId: uuid('snapshot_id').references(() => reportSnapshots.id, {
      onDelete: 'restrict',
    }),
    /** Single-item audience: one corrective action, and no listing route to reach more. */
    correctiveActionId: uuid('corrective_action_id').references(() => correctiveActions.id, {
      onDelete: 'restrict',
    }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    /** Who a submission through this link is attributed to — a public page has no session. */
    issuedToUserId: uuid('issued_to_user_id').references(() => users.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    maxUses: integer('max_uses'),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    revokeReason: text('revoke_reason'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('report_access_token_hash_key').on(table.tokenHash),
    index('report_access_token_action_idx').on(table.correctiveActionId),
    index('report_access_token_expiry_idx').on(table.expiresAt),
    index('report_access_token_snapshot_idx').on(table.snapshotId, table.revokedAt),
  ],
);
