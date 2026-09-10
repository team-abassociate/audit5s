import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ROLES,
  USER_STATUSES,
  MEMBERSHIP_STATUSES,
  S_SECTIONS,
  CHECKLIST_VERSION_STATUSES,
  IMPORT_JOB_STATUSES,
} from '@audit5s/contracts';

/**
 * Postgres enum types, built from the contracts arrays rather than retyped, so the
 * database and the wire format cannot drift.
 *
 * Added alongside the tables that reference them, phase by phase, so an enum never
 * exists in the schema before anything can hold one of its values.
 */
export const roleEnum = pgEnum('role', ROLES);
export const userStatusEnum = pgEnum('user_status', USER_STATUSES);
export const membershipStatusEnum = pgEnum('membership_status', MEMBERSHIP_STATUSES);

// Phase 2 (0005_zones_and_checklists).
export const sSectionEnum = pgEnum('s_section', S_SECTIONS);
export const checklistVersionStatusEnum = pgEnum(
  'checklist_version_status',
  CHECKLIST_VERSION_STATUSES,
);
export const importJobStatusEnum = pgEnum('import_job_status', IMPORT_JOB_STATUSES);
