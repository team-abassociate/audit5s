import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { membershipStatusEnum, roleEnum, userStatusEnum } from './enums';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable(
  'user',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    loginId: text('login_id').notNull(),
    fullName: text('full_name').notNull(),
    phoneE164: text('phone_e164').notNull(),
    email: text('email'),
    role: roleEnum('role').notNull(),
    /** Argon2id. Never null, never plaintext, never returned by an API. */
    passwordHash: text('password_hash').notNull(),
    passwordAlgo: text('password_algo').notNull().default('argon2id'),
    /** CH-1: the phone number is a bootstrap credential only. */
    mustResetPassword: boolean('must_reset_password').notNull().default(true),
    bootstrapExpiresAt: timestamp('bootstrap_expires_at', { withTimezone: true }),
    status: userStatusEnum('status').notNull().default('INVITED'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Archived users keep their login ID reserved forever, so a new employee never
    // inherits an old identity (§12.2). Hence a plain unique, not a partial one.
    uniqueIndex('user_login_id_key').on(table.loginId),
    uniqueIndex('user_phone_active_key')
      .on(table.phoneE164)
      .where(sql`archived_at IS NULL`),
    uniqueIndex('user_email_active_key')
      .on(sql`lower(email)`)
      .where(sql`email IS NOT NULL AND archived_at IS NULL`),
    index('user_role_status_idx').on(table.role, table.status),
  ],
);

export const units = pgTable(
  'unit',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** The Unit's only identifier. There is no separate code (§5.2). */
    name: text('name').notNull(),
    address: text('address'),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    postalCode: text('postal_code'),
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    contactEmail: text('contact_email'),
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),
    /** NULL disables geofencing for the Unit. */
    geofenceRadiusM: integer('geofence_radius_m').default(300),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    /**
     * Which sector this Unit operates in, narrowing the checklists its audits offer
     * (0018). NULL narrows nothing, which is every Unit's behaviour before that migration.
     */
    industryId: uuid('industry_id'),
    /** CH-5 soft cap. */
    photoCapPerZone: integer('photo_cap_per_zone').notNull().default(30),
    version: integer('version').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unit_name_key').on(table.name),
    index('unit_archived_at_idx').on(table.archivedAt),
  ],
);

/**
 * The single most security-critical table in the system: every scope predicate in PART 6
 * resolves through it. Rows are never deleted — revoking sets `status` and `validTo`.
 */
export const unitMemberships = pgTable(
  'unit_membership',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => units.id, { onDelete: 'restrict' }),
    /** Denormalised from the user; a database trigger keeps it honest. */
    role: roleEnum('role').notNull(),
    status: membershipStatusEnum('status').notNull().default('ACTIVE'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    assignedByUserId: uuid('assigned_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unit_membership_active_pair_key')
      .on(table.userId, table.unitId)
      .where(sql`status = 'ACTIVE'`),
    // Invariant M-1 (DECISIONS.md R-3a): a COORDINATOR or ZONE_LEADER may hold at most
    // one ACTIVE membership, which is what makes `own_unit`'s LIMIT 1 deterministic.
    uniqueIndex('unit_membership_one_active_admin')
      .on(table.userId)
      .where(sql`status = 'ACTIVE' AND role IN ('COORDINATOR','ZONE_LEADER')`),
    index('unit_membership_unit_role_status_idx').on(table.unitId, table.role, table.status),
    index('unit_membership_user_status_idx').on(table.userId, table.status),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(unitMemberships),
}));

export const unitsRelations = relations(units, ({ many }) => ({
  memberships: many(unitMemberships),
}));

export const unitMembershipsRelations = relations(unitMemberships, ({ one }) => ({
  user: one(users, { fields: [unitMemberships.userId], references: [users.id] }),
  unit: one(units, { fields: [unitMemberships.unitId], references: [units.id] }),
}));
