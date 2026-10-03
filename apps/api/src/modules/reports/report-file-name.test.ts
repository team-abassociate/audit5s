import { describe, expect, it } from 'vitest';
import { reportFileName } from './report-file-name';
import {
  fixtureAfterEvidencePayload,
  fixtureSummaryPayload,
  fixtureZonePayload,
} from './templates/fixture';

describe('reportFileName', () => {
  it('names a Zone report for its Unit, Zone, kind, audit date and version', () => {
    const payload = fixtureZonePayload();
    const name = reportFileName(payload);
    expect(name).toMatch(/\.pdf$/);
    expect(name.startsWith(`${payload.unit.name} - `)).toBe(true);
    expect(name).toContain(' - Initial - ');
    expect(name).toMatch(new RegExp(` - v${payload.version}\\.pdf$`));
    expect(name).not.toMatch(/[–—]/);
  });

  it('says After-evidence for an after-evidence report', () => {
    expect(reportFileName(fixtureAfterEvidencePayload())).toContain(' - After-evidence - ');
  });

  it('counts the Zones of a summary, and names the span of a multi-audit selection', () => {
    const payload = {
      ...fixtureSummaryPayload(),
      auditDateRange: { from: '2026-09-01T05:00:00.000Z', to: '2026-09-04T05:00:00.000Z' },
    };
    const name = reportFileName(payload);
    expect(name).toContain(` - Unit summary - ${payload.zones.length} Zone`);
    expect(name).toContain(' - 01 Sept 2026 to 04 Sept 2026 - ');
  });

  it('strips what a file system or mail client refuses, and stays short', () => {
    const payload = fixtureZonePayload();
    payload.unit.name = 'Plant: A/B "North" <old>?* |' + 'x'.repeat(300) + '. ';
    const name = reportFileName(payload);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name.length).toBeLessThanOrEqual(154);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});
