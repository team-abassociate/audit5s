import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { roleEnum } from './enums';
import { units, users } from './identity';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** Seed data generated from PART 6 by `apps/api/src/seed.ts`. */
export const permissions = pgTable(
  'permission',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
    description: text('description').notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex('permission_resource_action_key').on(table.resource, table.action)],
);

export const rolePermissions = pgTable(
  'role_permission',
  {
    role: roleEnum('role').notNull(),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    /** Names the resolver that produces the SQL predicate. */
    scopeRule: text('scope_rule').notNull(),
    /** The prose constraint from the matrix cell, enforced in the service layer (AZ-5). */
    condition: text('condition'),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.role, table.permissionId] }),
    index('role_permission_role_idx').on(table.role),
  ],
);

export const devices = pgTable(
  'device',
  {
    /** Client-generated and stable per install, so a reinstall is a new device. */
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    platform: text('platform').notNull(),
    model: text('model'),
    osVersion: text('os_version'),
    appVersion: text('app_version'),
    pushToken: text('push_token'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index('device_user_revoked_idx').on(table.userId, table.revokedAt)],
);

export const refreshTokens = pgTable(
  'refresh_token',
  {
    /** = JTI. */
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'restrict' }),
    /** SHA-256 of the token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** Rotation family, for reuse detection (invariant R-1). */
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedById: uuid('replaced_by_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('refresh_token_hash_key').on(table.tokenHash),
    index('refresh_token_user_revoked_idx').on(table.userId, table.revokedAt),
    index('refresh_token_family_idx').on(table.familyId),
    index('refresh_token_expires_idx').on(table.expiresAt),
  ],
);

/**
 * Access-token denylist (§12.3). ARCHITECTURE.md named Redis; STACK.md §6 forbids it, and
 * the row count is bounded by the 15-minute access-token lifetime plus a sweep.
 */
export const revokedAccessTokens = pgTable(
  'revoked_access_token',
  {
    jti: uuid('jti').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('revoked_access_token_expires_idx').on(table.expiresAt),
    index('revoked_access_token_user_idx').on(table.userId),
  ],
);

/** Rate limiting and lockout (§12.11). Append-only: failed attempts are evidence. */
export const loginAttempts = pgTable(
  'login_attempt',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    /**
     * Text, not a foreign key: attempts against a login ID that does not exist are the
     * interesting ones, and must be recorded without revealing whether the account does.
     */
    loginId: text('login_id').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    deviceId: uuid('device_id'),
    succeeded: boolean('succeeded').notNull(),
    failureCode: text('failure_code'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('login_attempt_login_id_idx').on(table.loginId, table.occurredAt),
    index('login_attempt_ip_idx').on(table.ipAddress, table.occurredAt),
    index('login_attempt_occurred_idx').on(table.occurredAt),
  ],
);

/** OTP scaffold (§8.3). Codes are hashed, exactly as refresh tokens are. */
export const otpChallenges = pgTable(
  'otp_challenge',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    phoneE164: text('phone_e164').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ipAddress: text('ip_address'),
    ...timestamps,
  },
  (table) => [
    index('otp_challenge_phone_idx').on(table.phoneE164, table.createdAt),
    index('otp_challenge_expires_idx').on(table.expiresAt),
  ],
);

/**
 * Idempotency (§8.2). Postgres-only, 48 hours — ARCHITECTURE.md's Redis fast path is
 * removed with Redis itself, and at ~200 jobs/day it bought nothing.
 */
export const idempotencyKeys = pgTable(
  'idempotency_key',
  {
    key: text('key').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    endpoint: text('endpoint').notNull(),
    /** Same key, different body is a client bug: 422 IDEMPOTENCY_KEY_REUSE. */
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    /** Null while the first request is still in flight, so a retry waits rather than re-running. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idempotency_key_expires_idx').on(table.expiresAt),
    index('idempotency_key_user_idx').on(table.userId),
  ],
);

/** Invariant AL-1: insert-only, enforced by both privilege and trigger. */
export const auditLogs = pgTable(
  'audit_log',
  {
    /** Sequential by design: append-only and never exposed by ID. */
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    actorRole: roleEnum('actor_role'),
    /** Snapshotted, so a later rename does not obscure history. */
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    unitId: uuid('unit_id').references(() => units.id, { onDelete: 'restrict' }),
    before: jsonb('before'),
    after: jsonb('after'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    deviceId: uuid('device_id'),
    requestId: text('request_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_resource_idx').on(table.resourceType, table.resourceId, table.occurredAt),
    index('audit_log_actor_idx').on(table.actorUserId, table.occurredAt),
    index('audit_log_action_idx').on(table.action, table.occurredAt),
    index('audit_log_unit_idx').on(table.unitId, table.occurredAt),
  ],
);
