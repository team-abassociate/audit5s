import type {
  AssignmentStatus,
  AuditStatus,
  AuditType,
  AuditZoneStatus,
  ChecklistVersionStatus,
  CorrectiveActionStatus,
  EvidenceKind,
  NotificationEventType,
  ReportKind,
  Role,
  SSection,
  SubmissionChannel,
  SyncEntityType,
  UserStatus,
} from '@audit5s/contracts';

/**
 * Words for the enums, in one place, so a status reads the same on every screen and no
 * `SNAKE_CASE` token reaches a person (UX audit 2026-10-03: G5, AU7, CA6, R6, US5, S4x).
 *
 * The wording matches the field app's `src/lib/labels.ts`, so a status or a role reads the
 * same on the phone and in the portal.
 */

export const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  COORDINATOR: 'Coordinator',
  CONSULTANT: 'Consultant',
  ZONE_LEADER: 'Zone Leader',
};

export const ROLE_PLURAL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admins',
  COORDINATOR: 'Coordinators',
  CONSULTANT: 'Consultants',
  ZONE_LEADER: 'Zone Leaders',
};

/** A role from a row the type system only knows as a string; unknown values read as-is. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—';
  return ROLE_LABEL[role as Role] ?? humanize(role);
}

export const USER_STATUS_LABEL: Record<UserStatus, string> = {
  ACTIVE: 'Active',
  INVITED: 'Invited',
  DISABLED: 'Disabled',
  LOCKED: 'Locked',
};

export const AUDIT_TYPE_LABEL: Record<AuditType, string> = {
  EXTERNAL_5S: 'External 5S audit',
  CROSS_5S: 'Cross audit',
  WALK_BY: 'Walk-by',
};

export function auditTypeLabel(type: string | null | undefined): string {
  if (!type) return '—';
  return AUDIT_TYPE_LABEL[type as AuditType] ?? humanize(type);
}

export const AUDIT_STATUS_LABEL: Record<AuditStatus, string> = {
  ASSIGNED: 'Assigned',
  READY: 'Ready to start',
  IN_PROGRESS: 'In progress',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  CORRECTIVE_ACTION_OPEN: 'Actions open',
  PARTIALLY_CLOSED: 'Partly closed',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

/** One Zone of an audit. DRAFT is a Zone the auditor named but has not answered yet. */
export const ZONE_STATUS_LABEL: Record<AuditZoneStatus, string> = {
  DRAFT: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  WITHDRAWN: 'Withdrawn',
};

export const ASSIGNMENT_STATUS_LABEL: Record<AssignmentStatus, string> = {
  ASSIGNED: 'Assigned',
  ACCEPTED: 'Accepted',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

/**
 * A corrective action's status in words (R-43(a)): VERIFIED reads **Closed** — a Zone
 * Leader's after-photo closes it with nobody verifying it. Whether a reviewer approved it
 * is said beside the status, not folded into it. WITHDRAWN (R-31) is not "Closed": nobody
 * did any work.
 */
export const ACTION_STATUS_LABEL: Record<CorrectiveActionStatus, string> = {
  OPEN: 'Open',
  ACTION_SUBMITTED: 'Submitted',
  NOT_POSSIBLE: 'Not possible',
  VERIFIED: 'Closed',
  REOPENED: 'Reopened',
  WITHDRAWN: 'Withdrawn',
};

export const CHECKLIST_VERSION_STATUS_LABEL: Record<ChecklistVersionStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  SUPERSEDED: 'Replaced',
  ARCHIVED: 'Archived',
};

/** How an answer reached us. "Zone Leader link" is the PDF's per-item link (R-22). */
export const SUBMISSION_CHANNEL_LABEL: Record<SubmissionChannel, string> = {
  MOBILE: 'field app',
  WEB_TOKEN: 'Zone Leader link',
  WEB_SESSION: 'web portal',
};

export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  AUDITOR_SELFIE: 'Auditor photo',
  QUESTION_EVIDENCE: 'Question photo',
  WALK_BY_PHOTO: 'Walk-by photo',
  CORRECTIVE_AFTER: 'After photo',
};

/**
 * Report editions, in the words the PDF itself prints ("Zone report", "After-evidence
 * zone report") and its file name uses. ARCHITECTURE PART 1 settles "Initial" and
 * "After-Evidence" as the vocabulary, so the audit's "Before fixes / After fixes" is not used.
 */
export const REPORT_EDITION_LABEL: Record<ReportKind, string> = {
  INITIAL_ZONE: 'Initial',
  AFTER_EVIDENCE_ZONE: 'After-evidence',
  MULTI_ZONE_SUMMARY: 'Unit summary',
};

/** What a notification is about, for its category column. */
export const NOTIFICATION_CATEGORY_LABEL: Record<NotificationEventType, string> = {
  UNIT_ASSIGNED: 'Unit access',
  UNIT_ACCESS_REVOKED: 'Unit access',
  AUDIT_ASSIGNED: 'Audit',
  AUDIT_STARTED: 'Audit',
  AUDIT_PAUSED: 'Audit',
  AUDIT_COMPLETED: 'Audit',
  CORRECTIVE_ACTION_SUBMITTED: 'Corrective action',
  CORRECTIVE_ACTION_VERIFIED: 'Corrective action',
  CORRECTIVE_ACTION_REOPENED: 'Corrective action',
  CORRECTIVE_ACTION_OPENED: 'Corrective action',
  CORRECTIVE_ACTION_WITHDRAWN: 'Corrective action',
  CORRECTIVE_ACTION_OVERDUE: 'Overdue',
  SYNC_FAILURE: 'Sync',
  CHECKLIST_PUBLISHED: 'Checklist',
  REPORT_GENERATED: 'Report',
  DATA_INTEGRITY_ALERT: 'Data check',
};

/** Each notification event in a sentence fragment, for the preferences table. */
export const NOTIFICATION_EVENT_LABEL: Record<NotificationEventType, string> = {
  UNIT_ASSIGNED: 'Given access to a Unit',
  UNIT_ACCESS_REVOKED: 'Access to a Unit removed',
  AUDIT_ASSIGNED: 'Audit assigned',
  AUDIT_STARTED: 'Audit started',
  AUDIT_PAUSED: 'Audit paused',
  AUDIT_COMPLETED: 'Audit completed',
  CORRECTIVE_ACTION_SUBMITTED: 'Corrective action answered',
  CORRECTIVE_ACTION_VERIFIED: 'Corrective action approved',
  CORRECTIVE_ACTION_REOPENED: 'Corrective action reopened',
  CORRECTIVE_ACTION_OPENED: 'New corrective action after a correction',
  CORRECTIVE_ACTION_WITHDRAWN: 'Corrective action withdrawn',
  CORRECTIVE_ACTION_OVERDUE: 'Corrective action overdue',
  SYNC_FAILURE: 'Field work held for review',
  CHECKLIST_PUBLISHED: 'Checklist published',
  REPORT_GENERATED: 'Report ready',
  DATA_INTEGRITY_ALERT: 'Nightly data check',
};

/** What a held sync item was, in the words the field app uses for it. */
export const SYNC_ENTITY_LABEL: Record<SyncEntityType, string> = {
  audit: 'Audit',
  audit_zone: 'Zone of an audit',
  question_response: 'Answer to a question',
  evidence: 'Photo',
  corrective_action_submission: 'Corrective action answer',
};

export function syncEntityLabel(type: string): string {
  return SYNC_ENTITY_LABEL[type as SyncEntityType] ?? humanize(type);
}

/**
 * The five 5S sections, named one way everywhere in the portal: "S1 Sort (Seiri)" (AU7).
 * The PDF keeps the workbook's own "1S – SEIRI (SORT)" (`S_SECTION_LABELS` in
 * `@audit5s/domain`), which is what the client's paper copy prints.
 */
export const SECTION_LABEL: Record<SSection, string> = {
  S1_SORT: 'S1 Sort (Seiri)',
  S2_SET_IN_ORDER: 'S2 Set in order (Seiton)',
  S3_SHINE: 'S3 Shine (Seiso)',
  S4_STANDARDIZE: 'S4 Standardize (Seiketsu)',
  S5_SUSTAIN: 'S5 Sustain (Shitsuke)',
};

/** The same names without the Japanese word, where a column or a chart axis is narrow. */
export const SECTION_SHORT_LABEL: Record<SSection, string> = {
  S1_SORT: 'S1 Sort',
  S2_SET_IN_ORDER: 'S2 Set in order',
  S3_SHINE: 'S3 Shine',
  S4_STANDARDIZE: 'S4 Standardize',
  S5_SUSTAIN: 'S5 Sustain',
};

/** `SOME_TOKEN` → "Some token", the last resort for a value no map knows yet. */
export function humanize(token: string): string {
  const words = token.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `lang` for a name a person typed (a Zone, a Unit): `hi` when it is written in Devanagari,
 * so a screen reader voices it and the browser shapes it as Indic text (D14). English names
 * get nothing and inherit the page's `en`.
 */
// ponytail: Hindi and Marathi share the script and a typed name says neither; `hi` for both
// until a Zone carries its language.
export function nameLang(name: string | null | undefined): 'hi' | undefined {
  return name && /\p{Script=Devanagari}/u.test(name) ? 'hi' : undefined;
}
