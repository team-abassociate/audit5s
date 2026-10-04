import { describe, expect, it } from 'vitest';
import { NOTIFICATION_EVENT_TYPES } from '@audit5s/contracts';
import type { DomainEventJob } from '../../infrastructure/queue/domain-events';
import { RECIPIENT_ROLES, firstExternalChannel, renderNotification } from './notification-policy';

const job = (type: DomainEventJob['type'], data: DomainEventJob['data'] = {}): DomainEventJob => ({
  type,
  eventId: '01930000-0000-7000-8000-000000000001',
  occurredAt: '2026-09-11T10:00:00.000Z',
  actorUserId: null,
  unitId: null,
  resourceType: 'audit',
  resourceId: null,
  data,
});

describe('notification policy (§5.9)', () => {
  it('has a recipient rule and a message for every event type', () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(RECIPIENT_ROLES[type]).toBeDefined();
      const { title, body } = renderNotification(job(type));
      expect(title.length).toBeGreaterThan(0);
      expect(body).not.toMatch(/undefined/);
    }
  });

  it('names the auditor, the Unit and the day a completed audit finished', () => {
    const { title, body } = renderNotification(
      job('AUDIT_COMPLETED', {
        auditType: 'EXTERNAL_5S',
        actionsOpened: 3,
        auditorName: 'Priya Nair',
        unitName: 'Nashik Plant',
        completedAt: '2026-09-12T08:30:00.000Z',
      }),
    );
    // A queue of notifications that all read "Audit completed" is one notification
    // repeated: the title has to say which audit this was.
    expect(title).toContain('Priya Nair');
    expect(title).toContain('Nashik Plant');
    expect(body).toContain('3 corrective actions opened');
    // The shared formatter (packages/domain), in IST: no longer the platform's locale data.
    expect(body).toContain('12 Sept 2026');
  });

  it('still renders a sentence for an event stored before those fields existed', () => {
    // Notifications are durable rows. One enqueued by the previous build carries only
    // `auditType` and `actionsOpened`, and must not render "undefined completed a ...".
    const { title, body } = renderNotification(
      job('AUDIT_COMPLETED', { auditType: 'EXTERNAL_5S', actionsOpened: 0 }),
    );
    expect(title).toBe('Audit completed');
    expect(title).not.toMatch(/undefined|null/);
    expect(body).not.toMatch(/undefined|null/);
    expect(body).toContain('no nonconformities');
  });

  it('falls back to the Unit alone when the auditor is not on the event', () => {
    const { title } = renderNotification(
      job('AUDIT_COMPLETED', { auditType: 'CROSS_5S', unitName: 'Pune Works' }),
    );
    expect(title).toBe('Cross 5S audit completed at Pune Works');
  });

  it('tries WhatsApp first for a template event, SMS only when WhatsApp is off', () => {
    const on = { whatsappEnabled: true, smsEnabled: true };
    expect(firstExternalChannel('AUDIT_ASSIGNED', on)).toBe('WHATSAPP');
    expect(firstExternalChannel('AUDIT_ASSIGNED', { ...on, whatsappEnabled: false })).toBe('SMS');
    expect(firstExternalChannel('AUDIT_ASSIGNED', { whatsappEnabled: false, smsEnabled: false })).toBeNull();
  });

  it('keeps everything else in the app', () => {
    expect(firstExternalChannel('CORRECTIVE_ACTION_SUBMITTED', { whatsappEnabled: true, smsEnabled: true })).toBeNull();
  });

  it('says who submitted a corrective action, and which audit it answers (F2)', () => {
    const { title, body } = renderNotification(
      job('CORRECTIVE_ACTION_SUBMITTED', {
        zoneCode: 'Z-03',
        zoneName: 'Press',
        questionNo: 12,
        option: 'COMPLETED',
        attemptNo: 1,
        auditType: 'EXTERNAL_5S',
        auditorName: 'Priya Nair',
        submittedByName: 'Sunita Rao',
      }),
    );
    // The person who answered leads; the auditor is where the finding came from, not who
    // fixed it. Four Consultants in three plants still tell their notices apart.
    expect(title).toBe('Sunita Rao submitted a corrective action');
    expect(body).toBe(
      'Zone 3 — Press, Q12: completed with an after photo (attempt 1) and closed. ' +
        'Regenerate the report to include it. From the External 5S audit by Priya Nair.',
    );
  });

  it('writes a Zone as the app does — "Zone 2", never the stored "Z-02"', () => {
    const { body } = renderNotification(job('CORRECTIVE_ACTION_VERIFIED', { zoneCode: 'Z-02', zoneName: 'Zone 2', questionNo: 4 }));
    expect(body).toBe('Zone 2, Q4 was verified.');
  });

  it('bundles a Zone’s overdue items into one notice for its leader (D10)', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      actionId: `01930000-0000-7000-8000-0000000000${10 + index}`,
      questionNo: index + 1,
      suggestionNo: null,
      daysOverdue: index,
    }));
    const { title, body } = renderNotification(
      job('CORRECTIVE_ACTION_OVERDUE', { zoneCode: 'Z-17', zoneName: 'Dispatch', assigneeName: 'Ravi Patil', items }),
    );
    expect(title).toBe('Overdue: 10 corrective actions in Zone 17 — Dispatch (Ravi Patil)');
    expect(body).toBe(
      'Q1, Q2, Q3, Q4, Q5, Q6, Q7, Q8 and 2 more are past their due date, the oldest by 9 days. ' +
        'Answer each with an after photo, or mark it not possible so it can be reviewed.',
    );
  });

  it('counts walk-by observations, which have no question to name', () => {
    const item = (questionNo: number | null) => ({ actionId: 'x', questionNo, suggestionNo: null, daysOverdue: 3 });
    const walkBy = renderNotification(job('CORRECTIVE_ACTION_OVERDUE', { zoneCode: 'Z-03', zoneName: 'Press', items: [item(null), item(null)] }));
    expect(walkBy.body).toMatch(/^2 walk-by observations are past their due date, the oldest by 3 days\./);
    const mixed = renderNotification(job('CORRECTIVE_ACTION_OVERDUE', { zoneCode: 'Z-03', zoneName: 'Press', items: [item(4), item(null)] }));
    expect(mixed.body).toMatch(/^Q4 and 1 walk-by observation are past/);
  });

  it('renders a one-item bundle, and a single item queued before D10, as one item', () => {
    const one = { actionId: '01930000-0000-7000-8000-000000000010', questionNo: null, suggestionNo: 2, daysOverdue: 1 };
    const bundled = renderNotification(job('CORRECTIVE_ACTION_OVERDUE', { zoneCode: 'Z-03', zoneName: 'Press', items: [one] }));
    expect(bundled.title).toBe('Overdue: Zone 3 — Press, overall action 2');
    expect(bundled.body).toContain('is 1 day past its due date');

    const legacy = renderNotification(job('CORRECTIVE_ACTION_OVERDUE', { zoneCode: 'Z-03', zoneName: 'Press', questionNo: 12, daysOverdue: 0 }));
    expect(legacy.title).toBe('Overdue: Zone 3 — Press, Q12');
    expect(legacy.body).toContain('is past its due date');
  });

  it('tells the Zone Leader why a restart withdrew their item (F1, R-33)', () => {
    const { body } = renderNotification(
      job('CORRECTIVE_ACTION_WITHDRAWN', { zoneCode: 'Z-03', zoneName: 'Press', questionNo: 12, auditorName: 'Priya Nair', cause: 'restart' }),
    );
    expect(body).toBe(
      'Zone 3 — Press, Q12 is withdrawn while Priya Nair re-checks the audit. ' +
        'Nothing is owed on it now; if it is still a finding when the audit is finished again, it comes back.',
    );
  });

  it('sums up the night’s data checks in one notice, a line per Unit (D10)', () => {
    const unit = { orphanEvidence: 0, staleAudits: 0, unsyncedDevices: 0, scoreDrift: 0, auditsSampled: 20 };
    const { title, body } = renderNotification(
      job('DATA_INTEGRITY_ALERT', {
        night: '2026-10-05',
        units: [
          { ...unit, unitId: 'a', unitName: 'Pune', orphanEvidence: 2 },
          { ...unit, unitId: 'b', unitName: 'Nashik', staleAudits: 1 },
        ],
      }),
    );
    expect(title).toBe('Nightly data check: findings in 2 Units');
    expect(body).toBe(
      'Pune: 2 photos recorded but never uploaded.\nNashik: 1 audit open for more than a week.\n' +
        'The check only reports these; it did not change anything.',
    );
  });

  it('says who started an audit and in which Unit', () => {
    const { title } = renderNotification(
      job('AUDIT_STARTED', { auditType: 'EXTERNAL_5S', auditorName: 'Priya Nair', unitName: 'Sahney Kirkwood' }),
    );
    expect(title).toBe('Priya Nair started an external 5S audit at Sahney Kirkwood');
  });

  it('renders an audit start stored before the auditor and Unit were on the event', () => {
    const { title } = renderNotification(job('AUDIT_STARTED', { auditType: 'EXTERNAL_5S' }));
    expect(title).toBe('Audit started');
  });

  it('tells an auditor assigned with others that the Zones are shared', () => {
    const { body } = renderNotification(
      job('AUDIT_ASSIGNED', { auditType: 'EXTERNAL_5S', unitName: 'Nashik', coAuditors: 2 }),
    );
    expect(body).toContain('together with 2 other auditors');
  });

  it('renders a submitted corrective action stored before the auditor was on the event', () => {
    const { title } = renderNotification(
      job('CORRECTIVE_ACTION_SUBMITTED', { zoneCode: 'Z-03', zoneName: 'Press', option: 'COMPLETED' }),
    );
    expect(title).toBe('Corrective action submitted');
    expect(title).not.toMatch(/undefined|null/);
  });

  it('tells the Zone Leader to stop when a finding is withdrawn (R-31)', () => {
    const { title, body } = renderNotification(
      job('CORRECTIVE_ACTION_WITHDRAWN', {
        zoneCode: 'Z-03',
        zoneName: 'Press',
        questionNo: 12,
        auditType: 'EXTERNAL_5S',
        auditorName: 'Priya Nair',
      }),
    );
    expect(title).toBe('Corrective action withdrawn');
    // The useful sentence is "you owe nothing", not "a status changed": somebody with this
    // on their list has been planning a walk to the Zone.
    expect(body).toContain('no longer a nonconformity');
    expect(body).toContain('Priya Nair');
    expect(body).toContain('Nothing is owed');
  });

  it('names a finding raised after the audit was already finished (R-31)', () => {
    const { title, body } = renderNotification(
      job('CORRECTIVE_ACTION_OPENED', {
        zoneCode: 'Z-04',
        zoneName: 'Assembly',
        questionNo: 7,
        auditType: 'EXTERNAL_5S',
        auditorName: 'Priya Nair',
        value: 'SCORE_0',
      }),
    );
    expect(title).toContain('Priya Nair');
    expect(body).toContain('Zone 4 — Assembly, Q7');
    // The auditor's words, never the stored token.
    expect(body).toContain('“Needs improvement”');
    expect(body).not.toContain('SCORE_0');
  });

  it('renders both R-31 events without the auditor, for an older stored row', () => {
    for (const type of ['CORRECTIVE_ACTION_OPENED', 'CORRECTIVE_ACTION_WITHDRAWN'] as const) {
      const { title, body } = renderNotification(job(type, { zoneCode: 'Z-01', zoneName: 'Press' }));
      expect(title).not.toMatch(/undefined|null/);
      expect(body).not.toMatch(/undefined|null/);
    }
  });

  it('says which item a corrective-action message is about', () => {
    const { body } = renderNotification(
      job('CORRECTIVE_ACTION_SUBMITTED', { zoneCode: 'Z-03', zoneName: 'Press', questionNo: 12, option: 'COMPLETED', attemptNo: 2 }),
    );
    expect(body).toBe(
      'Zone 3 — Press, Q12: completed with an after photo (attempt 2) and closed. Regenerate the report to include it.',
    );
  });

  it('names only the integrity findings that fired (§16.4, R-17b)', () => {
    const { title, body } = renderNotification(
      job('DATA_INTEGRITY_ALERT', {
        orphanEvidence: 2,
        staleAudits: 0,
        unsyncedDevices: 1,
        scoreDrift: 0,
        auditsSampled: 20,
      }),
    );

    expect(title).toBe('Data integrity check');
    // Singular and plural both, and the two zero counts absent rather than printed as "0".
    expect(body).toBe(
      '2 photos recorded but never uploaded; ' +
        '1 device holding an audit and not syncing. The check only reports these; it did not change anything.',
    );
    expect(body).not.toMatch(/stale|recomputation/);
  });

  it('reports drift against the size of the sample it was drawn from', () => {
    const { body } = renderNotification(
      job('DATA_INTEGRITY_ALERT', { orphanEvidence: 0, staleAudits: 0, unsyncedDevices: 0, scoreDrift: 1, auditsSampled: 20 }),
    );

    expect(body).toBe(
      '1 audit score that does not match a recomputation (of 20 checked). The check only reports these; it did not change anything.',
    );
  });

  it('reaches Super Admins and nobody else', () => {
    expect(RECIPIENT_ROLES.DATA_INTEGRITY_ALERT).toEqual(['SUPER_ADMIN']);
    // A 02:00 WhatsApp about an orphan photograph is how a channel gets muted.
    expect(firstExternalChannel('DATA_INTEGRITY_ALERT', { whatsappEnabled: true, smsEnabled: true })).toBeNull();
  });
});
