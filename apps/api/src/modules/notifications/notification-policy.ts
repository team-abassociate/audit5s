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
  SYNC_FAILURE: ['SUPER_ADMIN'],
  CHECKLIST_PUBLISHED: ['SUPER_ADMIN'],
};

/**
 * §5.9's WhatsApp template set: the events worth a message outside the app — work handed
 * to someone (§2.5's assignment, §2.8's new actions) and work handed back.
 */
export const WHATSAPP_EVENTS: ReadonlySet<NotificationEventType> = new Set([
  'AUDIT_ASSIGNED',
  'AUDIT_COMPLETED',
  'CORRECTIVE_ACTION_REOPENED',
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
      return {
        title: 'Audit completed',
        body:
          opened === 0
            ? `${auditType} completed with no nonconformities.`
            : `${auditType} completed — ${opened} corrective action${opened === 1 ? '' : 's'} opened.`,
      };
    }
    case 'CORRECTIVE_ACTION_SUBMITTED':
      return {
        title: 'Corrective action submitted',
        body:
          `${item}${question}: ` +
          (data.option === 'NOT_POSSIBLE' ? 'marked not possible' : 'completed') +
          ` (attempt ${String(data.attemptNo ?? 1)}). Ready for review.`,
      };
    case 'CORRECTIVE_ACTION_VERIFIED':
      return { title: 'Corrective action verified', body: `${item}${question} was verified.` };
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
  }
}
