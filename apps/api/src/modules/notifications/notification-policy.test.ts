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

  it('tries WhatsApp first for a template event, SMS only when WhatsApp is off', () => {
    const on = { whatsappEnabled: true, smsEnabled: true };
    expect(firstExternalChannel('AUDIT_ASSIGNED', on)).toBe('WHATSAPP');
    expect(firstExternalChannel('AUDIT_ASSIGNED', { ...on, whatsappEnabled: false })).toBe('SMS');
    expect(firstExternalChannel('AUDIT_ASSIGNED', { whatsappEnabled: false, smsEnabled: false })).toBeNull();
  });

  it('keeps everything else in the app', () => {
    expect(firstExternalChannel('CORRECTIVE_ACTION_SUBMITTED', { whatsappEnabled: true, smsEnabled: true })).toBeNull();
  });

  it('says which item a corrective-action message is about', () => {
    const { body } = renderNotification(
      job('CORRECTIVE_ACTION_SUBMITTED', { zoneCode: '3', zoneName: 'Press', questionNo: 12, option: 'COMPLETED', attemptNo: 2 }),
    );
    expect(body).toBe('Zone 3 — Press, Q12: completed (attempt 2). Ready for review.');
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
