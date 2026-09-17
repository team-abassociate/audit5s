import type { NotificationEventType, Role } from '@audit5s/contracts';
import type { DomainEventJob } from '../../infrastructure/queue/domain-events';

/**
 * Who hears about what, on which channel, in what words (§4.2, §5.9).
 *
 * Pure, so the whole policy is one file a reader can check against the event table and a
 * test can pin. The event supplies the people it already knows (the assignee, the
 * submitter); the roles below are everyone else.
 */

/** Roles notified besides the event's named people. SUPER_ADMIN is organisation-wide. */
export const RECIPIENT_ROLES: Record<NotificationEventType, Role[]> = {
  UNIT_ASSIGNED: [],
  UNIT_ACCESS_REVOKED: [],
  AUDIT_ASSIGNED: [],
  AUDIT_STARTED: ['SUPER_ADMIN'],
  // N7: an abort notifies the Super Admin.
  AUDIT_PAUSED: ['SUPER_ADMIN'],
  // §2.8: new actions reach their Zone Leaders (named by the event) and the Coordinator.
  AUDIT_COMPLETED: ['SUPER_ADMIN', 'COORDINATOR'],
  // §7.3: "Submission notifies Super Admin."
  CORRECTIVE_ACTION_SUBMITTED: ['SUPER_ADMIN'],
  CORRECTIVE_ACTION_VERIFIED: ['COORDINATOR'],
  CORRECTIVE_ACTION_REOPENED: [],
  // The Zone Leader who owns the work is named by the event. The Coordinator runs the
  // Unit and is who chases it; the Super Admin sees every Unit's slippage. §7.3 gives the
  // due date teeth only if somebody is told it has passed.
  CORRECTIVE_ACTION_OVERDUE: ['SUPER_ADMIN', 'COORDINATOR'],
  SYNC_FAILURE: ['SUPER_ADMIN'],
  CHECKLIST_PUBLISHED: ['SUPER_ADMIN'],
  // §10.2's REPORT_GENERATED. The Super Admin who asked for it is the actor and is never
  // notified of their own act, so this reaches the Unit's Coordinator — the person who has
  // to act on a report they did not commission.
  REPORT_GENERATED: ['COORDINATOR'],
  // §16.4: orphan evidence, stale audits, quiet devices and score drift are all
  // "surfaced to Super Admin", and to nobody else — a Coordinator cannot act on any of
  // them and a nightly alert they cannot act on is a nightly alert they stop reading.
  DATA_INTEGRITY_ALERT: ['SUPER_ADMIN'],
};

/**
 * §5.9's WhatsApp template set: the events worth a message outside the app — work handed
 * to someone (§2.5's assignment, §2.8's new actions) and work handed back.
 */
export const WHATSAPP_EVENTS: ReadonlySet<NotificationEventType> = new Set([
  'AUDIT_ASSIGNED',
  'AUDIT_COMPLETED',
  'CORRECTIVE_ACTION_REOPENED',
  'CORRECTIVE_ACTION_OVERDUE',
]);

export interface RecipientSwitches {
  whatsappEnabled: boolean;
  smsEnabled: boolean;
}

/**
 * The one external channel to try first, if any (§5.9).
 *
 * IN_APP is always delivered and is not planned here. WhatsApp for a template event when
 * the recipient has it on; SMS only when WhatsApp is off for that recipient — its other
 * use, as the fallback after a WhatsApp failure, is decided at delivery time.
 */
export function firstExternalChannel(
  type: NotificationEventType,
  recipient: RecipientSwitches,
): 'WHATSAPP' | 'SMS' | null {
  if (!WHATSAPP_EVENTS.has(type)) return null;
  if (recipient.whatsappEnabled) return 'WHATSAPP';
  return recipient.smsEnabled ? 'SMS' : null;
}

const AUDIT_TYPE_LABEL: Record<string, string> = {
  EXTERNAL_5S: 'External 5S audit',
  CROSS_5S: 'Cross 5S audit',
  WALK_BY: 'Walk-by audit',
};

/**
 * A date a person reads, from an ISO timestamp. Falls back to the leading date portion
 * rather than throwing: a malformed timestamp must not cost someone their notification.
 */
function formatDay(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso.slice(0, 10)
    : at.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function renderNotification(event: DomainEventJob): { title: string; body: string } {
  const data = event.data;
  const auditType = AUDIT_TYPE_LABEL[String(data.auditType)] ?? 'Audit';
  const item = [
    data.zoneCode ? `Zone ${String(data.zoneCode)}` : null,
    data.zoneName ? String(data.zoneName) : null,
  ]
    .filter(Boolean)
    .join(' — ');
  const question = data.questionNo ? `, Q${String(data.questionNo)}` : '';

  switch (event.type) {
    case 'UNIT_ASSIGNED':
      return { title: 'Unit assigned', body: 'You have been given access to a Unit. Sync to see it.' };
    case 'UNIT_ACCESS_REVOKED':
      return {
        title: 'Unit access removed',
        body: 'Your access to a Unit has ended; its open assignments were cancelled.',
      };
    case 'AUDIT_ASSIGNED':
      return {
        title: 'New audit assigned',
        body:
          `${auditType} at ${String(data.unitName ?? 'your Unit')}` +
          (data.dueAt ? `, due ${String(data.dueAt).slice(0, 10)}` : '') +
          '.',
      };
    case 'AUDIT_STARTED':
      return {
        title: 'Audit started',
        body: `${auditType} started${data.locationSuspicious ? ' — the start location was flagged' : ''}.`,
      };
    case 'AUDIT_PAUSED':
      return {
        title: 'Audit paused',
        body: `${auditType} was paused${data.reason ? `: ${String(data.reason)}` : ''}. Nothing was discarded.`,
      };
    case 'AUDIT_COMPLETED': {
      const opened = Number(data.actionsOpened ?? 0);
      // The title names the auditor and the Unit, because a list of notifications that all
      // read "Audit completed" is a list of one notification repeated. Every part is
      // optional: an older event carries none of them and still renders a sentence.
      const who = data.auditorName ? String(data.auditorName) : null;
      const where = data.unitName ? String(data.unitName) : null;
      const when = data.completedAt ? ` on ${formatDay(String(data.completedAt))}` : '';
      const outcome =
        opened === 0
          ? 'no nonconformities were raised'
          : `${opened} corrective action${opened === 1 ? '' : 's'} opened`;
      return {
        title:
          who && where
            ? `${who} completed a ${auditType.toLowerCase()} at ${where}`
            : where
              ? `${auditType} completed at ${where}`
              : 'Audit completed',
        body: `Completed${when} — ${outcome}.`,
      };
    }
    case 'CORRECTIVE_ACTION_SUBMITTED':
      return {
        title: 'Corrective action submitted',
        // R-23: an after-photo closes the item at once; "not possible" still needs a decision.
        body:
          `${item}${question}: ` +
          (data.option === 'NOT_POSSIBLE'
            ? `marked not possible (attempt ${String(data.attemptNo ?? 1)}). Accept or reopen it.`
            : `completed with an after photo (attempt ${String(data.attemptNo ?? 1)}) and closed. Regenerate the report to include it.`),
      };
    case 'CORRECTIVE_ACTION_VERIFIED':
      return { title: 'Corrective action verified', body: `${item}${question} was verified.` };
    case 'CORRECTIVE_ACTION_OVERDUE': {
      const days = Number(data.daysOverdue ?? 0);
      const late =
        days <= 0 ? 'is past its due date' : `is ${days} day${days === 1 ? '' : 's'} past its due date`;
      const owner = data.assigneeName ? String(data.assigneeName) : null;
      return {
        title: owner
          ? `Overdue: ${item || 'a corrective action'} — ${owner}`
          : `Overdue: ${item || 'a corrective action'}`,
        // Says what to do, not only what is wrong. A notice that reports a fact and
        // proposes nothing is one more thing to feel bad about.
        body:
          `${item}${question} ${late}. ` +
          'Answer it with an after photo, or mark it not possible so it can be reviewed.',
      };
    }
    case 'CORRECTIVE_ACTION_REOPENED':
      return {
        title: 'Corrective action reopened',
        body: `${item}${question} needs another response${data.reason ? `: ${String(data.reason)}` : ''}.`,
      };
    case 'SYNC_FAILURE': {
      const total = Number(data.conflictCount ?? 0) + Number(data.rejectedCount ?? 0);
      return {
        title: 'Some field work needs attention',
        body:
          `${total} item${total === 1 ? '' : 's'} from a device could not be applied and ` +
          'are held for review. Nothing has been lost.',
      };
    }
    case 'CHECKLIST_PUBLISHED':
      return {
        title: 'Checklist published',
        body: `${String(data.templateName ?? 'A checklist')} v${String(data.versionNumber ?? '?')} is now live.`,
      };
    case 'DATA_INTEGRITY_ALERT': {
      // Only the non-zero findings are named. A body that lists four checks and four
      // zeroes every time teaches the reader to skip the line that matters.
      const parts = [
        count(data.orphanEvidence, 'evidence row', 'without an uploaded photograph'),
        count(data.staleAudits, 'audit', 'open for more than a week'),
        count(data.unsyncedDevices, 'device', 'holding an audit and not syncing'),
        count(data.scoreDrift, 'audit score', `that does not match a recomputation (of ${String(data.auditsSampled ?? 0)} checked)`),
      ].filter((part): part is string => part !== null);
      return {
        title: 'Data integrity check',
        // The worker only emits when something was found, so the empty case is unreachable
        // from the sweep. It is still written out, because a renderer whose fallback is a
        // bare full stop is one refactor away from sending one.
        body: parts.length === 0 ? 'No findings.' : `${parts.join('; ')}. Nothing was changed.`,
      };
    }
    case 'REPORT_GENERATED': {
      const version = Number(data.version ?? 1);
      return {
        title: 'Report ready',
        body:
          `${String(data.kindLabel ?? 'A report')}${item ? ` for ${item}` : ''} ` +
          `version ${version} is ready to download.`,
      };
    }
  }
}

/** `"3 evidence rows without an uploaded photograph"`, or null when there are none. */
function count(value: unknown, noun: string, tail: string): string | null {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n} ${noun}${n === 1 ? '' : 's'} ${tail}`;
}
