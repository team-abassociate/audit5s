import { pgEnum } from 'drizzle-orm/pg-core';
import {
  ROLES,
  USER_STATUSES,
  MEMBERSHIP_STATUSES,
  S_SECTIONS,
  CHECKLIST_VERSION_STATUSES,
  IMPORT_JOB_STATUSES,
  ASSIGNMENT_STATUSES,
  AUDIT_STATUSES,
  AUDIT_TYPES,
  AUDIT_ZONE_STATUSES,
  LOCATION_PROVIDERS,
  RESPONSE_VALUES,
  SYNC_STATES,
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

// Phase 3 (0006_audits_and_scoring).
export const auditTypeEnum = pgEnum('audit_type', AUDIT_TYPES);
export const auditStatusEnum = pgEnum('audit_status', AUDIT_STATUSES);
export const auditZoneStatusEnum = pgEnum('audit_zone_status', AUDIT_ZONE_STATUSES);
export const assignmentStatusEnum = pgEnum('assignment_status', ASSIGNMENT_STATUSES);
export const responseValueEnum = pgEnum('response_value', RESPONSE_VALUES);
export const syncStateEnum = pgEnum('sync_state', SYNC_STATES);
export const locationProviderEnum = pgEnum('location_provider', LOCATION_PROVIDERS);
