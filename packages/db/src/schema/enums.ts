import { pgEnum } from 'drizzle-orm/pg-core';
import { ROLES, USER_STATUSES, MEMBERSHIP_STATUSES } from '@audit5s/contracts';

/**
 * Postgres enum types, built from the contracts arrays rather than retyped, so the
 * database and the wire format cannot drift.
 *
 * Only the three the Phase 1 tables reference; later phases add their own alongside the
 * tables that use them.
 */
export const roleEnum = pgEnum('role', ROLES);
export const userStatusEnum = pgEnum('user_status', USER_STATUSES);
export const membershipStatusEnum = pgEnum('membership_status', MEMBERSHIP_STATUSES);
