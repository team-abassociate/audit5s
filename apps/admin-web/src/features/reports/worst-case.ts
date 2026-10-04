import type { ReportSnapshot } from '@audit5s/contracts';
import { HINDI_ZONE, LONG_PERSON, LONG_UNIT, uuid } from '@/features/audit-log/worst-case';

/**
 * Dev-only worst case for Reports (`?data=worst`): 400 snapshots over 40 audits and one
 * summary shelf — the longest Unit, auditor and Hindi Zone names, a 1,284-Zone summary, every
 * status, a long failure reason and documents with up to three earlier versions.
 */
const STATUSES = ['READY', 'READY', 'READY', 'QUEUED', 'RENDERING', 'FAILED'] as const;

export function worstReports(): ReportSnapshot[] {
  return Array.from({ length: 400 }, (_, i): ReportSnapshot => {
    const summary = i % 10 === 9;
    const zone = Math.floor(i / 4);
    const version = (i % 4) + 1;
    const at = new Date(Date.UTC(2026, 8, 30, 9, 0) - i * 3_600_000).toISOString();
    return {
      id: uuid(10_000 + i),
      kind: summary ? 'MULTI_ZONE_SUMMARY' : i % 3 ? 'INITIAL_ZONE' : 'AFTER_EVIDENCE_ZONE',
      version,
      supersedesSnapshotId: version > 1 ? uuid(10_000 + i - 1) : null,
      unitId: uuid(1 + (i % 2)),
      auditId: summary ? null : uuid(2_000 + (zone % 40)),
      auditZoneId: summary ? null : uuid(3_000 + zone),
      selectedZoneIds: null,
      selectedAuditZoneIds: summary ? [uuid(3_000 + zone)] : null,
      assignmentGroupId: null,
      payloadSchemaVersion: 1,
      templateVersion: '1.8.0',
      status: STATUSES[i % STATUSES.length]!,
      pdfObjectKey: null,
      pdfChecksumSha256: null,
      pageCount: i % 7 === 0 ? null : 1 + (i % 30),
      generatedByUserId: uuid(1),
      generatedByName: i % 2 ? LONG_PERSON : 'A',
      generatedAt: at,
      renderedAt: at,
      failedReason:
        i % 6 === 5 ? `The photograph for ${HINDI_ZONE} could not be read from storage after three attempts.` : null,
      withdrawnAt: null,
      subject: {
        unitName: i % 2 ? LONG_UNIT : 'A',
        zoneLabel: summary ? null : i % 3 ? `Zone ${zone} — ${HINDI_ZONE}` : `Zone ${zone} — ${LONG_UNIT} stores`,
        zoneCount: summary ? (i % 20 === 9 ? 1_284 : 1) : 1,
        auditorNames: i % 5 ? [LONG_PERSON, 'A'] : [],
        auditedFrom: i % 8 ? at : null,
        auditedTo: i % 8 ? at : null,
      },
    };
  });
}
