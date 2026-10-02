import { describe, expect, it } from 'vitest';
import { zoneDisplayLabel } from '@audit5s/domain';
import { reportSubject } from './report-subject';
import { fixtureSummaryPayload, fixtureZonePayload } from './templates/fixture';

describe('reportSubject', () => {
  it('names a Zone report for its Unit, its one Zone and the audit that finished it', () => {
    const payload = fixtureZonePayload();
    const zone = payload.zones[0]!;
    const subject = reportSubject(payload);
    expect(subject.unitName).toBe(payload.unit.name);
    expect(subject.zoneLabel).toBe(zoneDisplayLabel(zone.zoneCode, zone.zoneName));
    expect(subject.zoneCount).toBe(1);
    expect(subject.auditedFrom).toBe(payload.audit?.completedAt ?? zone.auditDate);
    expect(subject.auditedTo).toBe(subject.auditedFrom);
    expect(subject.auditorNames.length).toBeGreaterThan(0);
  });

  it('names no single Zone on a summary, counts its Zones and keeps the span it covers', () => {
    const payload = {
      ...fixtureSummaryPayload(),
      auditDateRange: { from: '2026-09-01T05:00:00.000Z', to: '2026-09-04T05:00:00.000Z' },
    };
    const subject = reportSubject(payload);
    expect(subject.zoneLabel).toBeNull();
    expect(subject.zoneCount).toBe(payload.zones.length);
    expect(subject.auditedFrom).toBe('2026-09-01T05:00:00.000Z');
    expect(subject.auditedTo).toBe('2026-09-04T05:00:00.000Z');
  });

  it('falls back to the Zones’ auditors for a payload frozen without auditorNames', () => {
    const payload = { ...fixtureSummaryPayload(), auditorNames: [] };
    const expected = [...new Set(payload.zones.map((zone) => zone.auditorName))];
    expect(reportSubject(payload).auditorNames).toEqual(expected);
  });
});
