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
    // en-IN abbreviates September as "Sept", not "Sep" — the assertion allows either
    // rather than pinning a detail of the platform's locale data.
    expect(body).toMatch(/12 Sept? 2026/);
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

  it('names the audit and the auditor a submitted corrective action answers', () => {
    const { title } = renderNotification(
      job('CORRECTIVE_ACTION_SUBMITTED', {
        zoneCode: '3',
        zoneName: 'Press',
        questionNo: 12,
        option: 'COMPLETED',
        attemptNo: 1,
        auditType: 'EXTERNAL_5S',
        auditorName: 'Priya Nair',
      }),
    );
    // Four Consultants in three plants produce a run of otherwise identical notices.
    expect(title).toContain('Priya Nair');
    expect(title).toContain('external 5s audit');
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
      job('CORRECTIVE_ACTION_SUBMITTED', { zoneCode: '3', zoneName: 'Press', option: 'COMPLETED' }),
    );
    expect(title).toBe('Corrective action submitted');
    expect(title).not.toMatch(/undefined|null/);
  });

  it('tells the Zone Leader to stop when a finding is withdrawn (R-31)', () => {
    const { title, body } = renderNotification(
      job('CORRECTIVE_ACTION_WITHDRAWN', {
        zoneCode: '3',
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
        zoneCode: '4',
        zoneName: 'Assembly',
        questionNo: 7,
        auditType: 'EXTERNAL_5S',
        auditorName: 'Priya Nair',
        value: 'SCORE_0',
      }),
    );
    expect(title).toContain('Priya Nair');
    expect(body).toContain('Zone 4 — Assembly, Q7');
    expect(body).toContain('SCORE_0');
  });

  it('renders both R-31 events without the auditor, for an older stored row', () => {
    for (const type of ['CORRECTIVE_ACTION_OPENED', 'CORRECTIVE_ACTION_WITHDRAWN'] as const) {
      const { title, body } = renderNotification(job(type, { zoneCode: '1', zoneName: 'Press' }));
      expect(title).not.toMatch(/undefined|null/);
      expect(body).not.toMatch(/undefined|null/);
    }
  });

  it('says which item a corrective-action message is about', () => {
    const { body } = renderNotification(
      job('CORRECTIVE_ACTION_SUBMITTED', { zoneCode: '3', zoneName: 'Press', questionNo: 12, option: 'COMPLETED', attemptNo: 2 }),
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
      '2 evidence rows without an uploaded photograph; ' +
        '1 device holding an audit and not syncing. Nothing was changed.',
    );
    expect(body).not.toMatch(/stale|recomputation/);
  });

  it('reports drift against the size of the sample it was drawn from', () => {
    const { body } = renderNotification(
      job('DATA_INTEGRITY_ALERT', { orphanEvidence: 0, staleAudits: 0, unsyncedDevices: 0, scoreDrift: 1, auditsSampled: 20 }),
    );

    expect(body).toBe(
      '1 audit score that does not match a recomputation (of 20 checked). Nothing was changed.',
    );
  });

  it('reaches Super Admins and nobody else', () => {
    expect(RECIPIENT_ROLES.DATA_INTEGRITY_ALERT).toEqual(['SUPER_ADMIN']);
    // A 02:00 WhatsApp about an orphan photograph is how a channel gets muted.
    expect(firstExternalChannel('DATA_INTEGRITY_ALERT', { whatsappEnabled: true, smsEnabled: true })).toBeNull();
  });
});
