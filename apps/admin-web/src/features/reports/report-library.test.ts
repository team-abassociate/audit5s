import { describe, expect, it } from 'vitest';
import type { ReportSnapshot } from '@audit5s/contracts';
import { buildLibrary, documentTitle, filterLibrary, NO_FILTERS, unitsOf } from './report-library';

let sequence = 0;

function snapshot(overrides: Partial<ReportSnapshot> & Pick<ReportSnapshot, 'kind'>): ReportSnapshot {
  sequence += 1;
  return {
    id: `00000000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    version: 1,
    supersedesSnapshotId: null,
    unitId: 'unit-abc',
    auditId: 'audit-1',
    auditZoneId: 'az-1',
    selectedZoneIds: null,
    selectedAuditZoneIds: null,
    assignmentGroupId: null,
    payloadSchemaVersion: 1,
    templateVersion: '1',
    status: 'READY',
    pdfObjectKey: null,
    pdfChecksumSha256: null,
    pageCount: 4,
    generatedByUserId: 'user-1',
    generatedByName: 'Aniket',
    generatedAt: `2026-09-30T10:${String(sequence).padStart(2, '0')}:00.000Z`,
    renderedAt: null,
    failedReason: null,
    withdrawnAt: null,
    subject: {
      unitName: 'ABC',
      zoneLabel: 'Zone 1 — Office',
      zoneCount: 1,
      auditorNames: ['Why'],
      auditedFrom: '2026-09-30T08:00:00.000Z',
      auditedTo: '2026-09-30T08:00:00.000Z',
    },
    ...overrides,
  };
}

const zone = (auditZoneId: string, zoneLabel: string, extra: Partial<ReportSnapshot> = {}) =>
  snapshot({
    kind: 'INITIAL_ZONE',
    auditZoneId,
    ...extra,
    subject: { ...snapshot({ kind: 'INITIAL_ZONE' }).subject, zoneLabel, ...extra.subject },
  });

describe('buildLibrary', () => {
  it('folds every version of one Zone into one document, newest version current', () => {
    const v1 = zone('az-2', 'Zone 2 — Press', { version: 1 });
    const v2 = zone('az-2', 'Zone 2 — Press', { version: 2, kind: 'AFTER_EVIDENCE_ZONE' });
    const v3 = zone('az-2', 'Zone 2 — Press', { version: 3, kind: 'AFTER_EVIDENCE_ZONE' });
    const [group] = buildLibrary([v2, v3, v1]);
    expect(group!.documents).toHaveLength(1);
    expect(group!.documents[0]!.latest.id).toBe(v3.id);
    expect(group!.documents[0]!.earlier.map((s) => s.id)).toEqual([v2.id, v1.id]);
  });

  it('files the Zone reports of one audit together, in Zone order', () => {
    const groups = buildLibrary([
      zone('az-10', 'Zone 10 — Yard'),
      zone('az-2', 'Zone 2 — Press'),
      zone('az-9', 'Zone 1 — Office', { auditId: 'audit-2' }),
    ]);
    expect(groups).toHaveLength(2);
    const audit1 = groups.find((group) => group.key === 'audit:audit-1')!;
    expect(audit1.documents.map((d) => d.latest.subject.zoneLabel)).toEqual([
      'Zone 2 — Press',
      'Zone 10 — Yard',
    ]);
  });

  it('keeps two summaries of different Zones apart, and folds a regenerated one', () => {
    const summary = (ids: string[], version: number) =>
      snapshot({
        kind: 'MULTI_ZONE_SUMMARY',
        auditId: null,
        auditZoneId: null,
        selectedAuditZoneIds: ids,
        version,
      });
    const first = summary(['a', 'b'], 1);
    const other = summary(['c'], 2);
    const again = summary(['b', 'a'], 3);
    const [group] = buildLibrary([first, other, again]);
    expect(group!.kind).toBe('SUMMARIES');
    expect(group!.documents).toHaveLength(2);
    const folded = group!.documents.find((d) => d.latest.id === again.id)!;
    expect(folded.earlier.map((s) => s.id)).toEqual([first.id]);
  });

  it('orders groups by their newest activity', () => {
    const older = zone('az-1', 'Zone 1', { auditId: 'old', generatedAt: '2026-09-01T00:00:00.000Z' });
    const newer = zone('az-5', 'Zone 5', { auditId: 'new', generatedAt: '2026-09-29T00:00:00.000Z' });
    expect(buildLibrary([older, newer]).map((group) => group.key)).toEqual(['audit:new', 'audit:old']);
  });
});

describe('filterLibrary', () => {
  const library = buildLibrary([
    zone('az-1', 'Zone 1 — Office'),
    zone('az-2', 'Zone 2 — Press', { status: 'FAILED' }),
    zone('az-3', 'Zone 3 — Stores', {
      unitId: 'unit-xyz',
      auditId: 'audit-x',
      subject: {
        unitName: 'Xyz',
        zoneLabel: 'Zone 3 — Stores',
        zoneCount: 1,
        auditorNames: ['Geetanjali'],
        auditedFrom: null,
        auditedTo: null,
      },
    }),
  ]);
  const titles = (groups: ReturnType<typeof filterLibrary>) =>
    groups.flatMap((group) => group.documents.map((d) => d.latest.subject.zoneLabel));

  it('narrows to one Unit', () => {
    expect(titles(filterLibrary(library, { ...NO_FILTERS, unitId: 'unit-xyz' }))).toEqual([
      'Zone 3 — Stores',
    ]);
  });

  it('narrows by status, by the current version', () => {
    expect(titles(filterLibrary(library, { ...NO_FILTERS, status: 'FAILED' }))).toEqual([
      'Zone 2 — Press',
    ]);
  });

  it('matches every word of a search across Unit, Zone and auditor', () => {
    expect(titles(filterLibrary(library, { ...NO_FILTERS, search: 'xyz geet' }))).toEqual([
      'Zone 3 — Stores',
    ]);
    expect(filterLibrary(library, { ...NO_FILTERS, search: 'nothing-like-this' })).toEqual([]);
  });
});

describe('labels', () => {
  it('lists each Unit once, by name', () => {
    expect(unitsOf([zone('a', 'Z'), zone('b', 'Z')])).toEqual([
      { id: 'unit-abc', name: 'ABC' },
    ]);
  });

  it('titles a summary by its Zones and the days they were audited', () => {
    const summary = snapshot({
      kind: 'MULTI_ZONE_SUMMARY',
      subject: {
        unitName: 'ABC',
        zoneLabel: null,
        zoneCount: 5,
        auditorNames: [],
        auditedFrom: '2026-09-30T08:00:00.000Z',
        auditedTo: '2026-09-30T08:00:00.000Z',
      },
    });
    expect(documentTitle(summary)).toMatch(/^5 Zones · audited 30 Sept? 2026$/);
  });
});
