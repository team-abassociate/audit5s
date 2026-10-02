import type { AuditStatus, AuditType, CorrectiveActionStatus, Role, UserStatus } from '@audit5s/contracts';
import type { Band } from './gemba';

/** Words for the enums, in one place, so a status reads the same on every screen. */
type Tone = Band | 'muted';

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  CONSULTANT: 'Consultant',
  COORDINATOR: 'Coordinator',
  ZONE_LEADER: 'Zone Leader',
};

export const USER_STATUS: Record<UserStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  INVITED: { label: 'Invited', tone: 'warn' },
  DISABLED: { label: 'Disabled', tone: 'crit' },
  LOCKED: { label: 'Locked', tone: 'crit' },
};

export const AUDIT_TYPE_LABELS: Record<AuditType, string> = {
  EXTERNAL_5S: 'External 5S audit',
  CROSS_5S: 'Cross audit',
  WALK_BY: 'Walk-by',
};

export const AUDIT_STATUS_LABELS: Record<AuditStatus, string> = {
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

/** The admin web's `STATUS_TONE` (AuditsPage), so a status wears the same chip in both apps. */
export const AUDIT_STATUS_TONE: Record<AuditStatus, Tone> = {
  ASSIGNED: 'muted',
  READY: 'muted',
  IN_PROGRESS: 'warn',
  PAUSED: 'warn',
  COMPLETED: 'ok',
  CORRECTIVE_ACTION_OPEN: 'warn',
  PARTIALLY_CLOSED: 'warn',
  CLOSED: 'ok',
  CANCELLED: 'crit',
};

/**
 * A corrective action's status in words (R-43).
 *
 * VERIFIED reads **Closed**: since R-23 a Zone Leader's after-photo closes the item with
 * nobody verifying it, and calling that "verified" claimed an inspection that never happened.
 * Whether a reviewer approved it is said beside the status, not folded into it.
 */
export const ACTION_STATUS_LABELS: Record<CorrectiveActionStatus, string> = {
  OPEN: 'Open',
  ACTION_SUBMITTED: 'Submitted',
  NOT_POSSIBLE: 'Not possible',
  VERIFIED: 'Closed',
  REOPENED: 'Reopened',
  WITHDRAWN: 'Withdrawn',
};

export const ACTION_STATUS_TONE: Record<CorrectiveActionStatus, Tone> = {
  OPEN: 'muted',
  ACTION_SUBMITTED: 'warn',
  NOT_POSSIBLE: 'warn',
  VERIFIED: 'ok',
  REOPENED: 'crit',
  WITHDRAWN: 'muted',
};

/**
 * Finished, in the sense §7.1 means it.
 *
 * An audit rarely *rests* on `COMPLETED` — materialising its corrective actions rolls it
 * onward in the same transaction (R-13b) — so `status === 'COMPLETED'` is the wrong
 * question everywhere.
 */
export function isFinished(status: string): boolean {
  return ['COMPLETED', 'CORRECTIVE_ACTION_OPEN', 'PARTIALLY_CLOSED', 'CLOSED'].includes(status);
}

/**
 * Somebody is actually auditing it. `?active=true` also returns ASSIGNED and READY (selfie
 * taken, nothing answered), which are waiting rather than running.
 */
export function isRunning(status: string): boolean {
  return status === 'IN_PROGRESS' || status === 'PAUSED';
}

/** `ACTION_SUBMITTED` → "Action submitted", for enums with no hand-written label. */
export function humanize(value: string): string {
  const words = value.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
