/**
 * Development only: the audits screen at its worst (`/audits?data=worst`, loaded by
 * `data.ts`). Long Unit, auditor and Zone Leader names, Hindi Zone names, an all-N/A section,
 * a cancelled audit with points on it, a 0-, 1- and 1,284-mark audit, and 1,000 rows.
 */
import type { AuditStatus, SSection } from '@audit5s/contracts';

const UNIT = 'Shree Venkateshwara Precision Forgings & Auto Components Pvt Ltd';
const AUDITOR = 'Mr. Venkataraghavan Subramaniam-Iyengar & Mrs. Priyadarshini Ramachandran';
const LEADER = 'Priyadarshini Ramachandran-Venkataraghavan';
const VERSION = '00000000-0000-4000-8000-00000000c0de';
const SECTIONS: SSection[] = ['S1_SORT', 'S2_SET_IN_ORDER', 'S3_SHINE', 'S4_STANDARDIZE', 'S5_SUSTAIN'];
const STATUSES: AuditStatus[] = [
  'IN_PROGRESS',
  'CANCELLED',
  'CORRECTIVE_ACTION_OPEN',
  'PAUSED',
  'CLOSED',
  'ASSIGNED',
  'PARTIALLY_CLOSED',
  'COMPLETED',
  'READY',
];

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = (n: number) => new Date(Date.UTC(2026, 9, 3, 12) - n * 3_600_000).toISOString();
const totals = (raw: number, max: number) => ({
  rawScore: raw,
  maxScore: max,
  scorePercentage: max === 0 ? null : (raw / max) * 100,
});

function audit(n: number) {
  const marks = [totals(0, 100), totals(1, 2), totals(1284, 1400), totals(0, 0)][n % 4]!;
  return {
    id: id(n),
    unitId: id(9000),
    unitName: n % 3 === 0 ? UNIT : `Unit ${n}`,
    auditType: n % 5 === 0 ? 'WALK_BY' : 'EXTERNAL_5S',
    scored: n % 5 !== 0,
    status: STATUSES[n % STATUSES.length]!,
    auditorUserId: id(8000 + (n % 7)),
    auditorName: n % 2 === 0 ? AUDITOR : 'A',
    assignmentId: null,
    assignmentGroupId: null,
    checklistVersionId: VERSION,
    totals: marks,
    createdAt: at(n),
    updatedAt: at(n),
  };
}

const QUESTIONS = Array.from({ length: 50 }, (_, index) => ({
  id: id(5000 + index),
  versionId: VERSION,
  section: SECTIONS[Math.floor(index / 10)]!,
  orderInSection: (index % 10) + 1,
  globalOrder: index + 1,
  text:
    index % 7 === 0
      ? 'Are all unwanted items, obsolete fixtures, broken pallets, scrap bins and personal belongings removed from the workstation, the aisle markings and the material staging area before the start of every shift?'
      : `Question ${index + 1} of the checklist`,
  guidance: null,
  allowsNa: true,
  requiresEvidenceOnNonconformity: true,
}));

function zone(n: number, name: string) {
  const zoneId = id(7000 + n);
  // Zone 1's S2 is all NA: it must read N/A, never 0.
  const value = (index: number) =>
    n === 1 && SECTIONS[Math.floor(index / 10)] === 'S2_SET_IN_ORDER' ? 'NA' : index % 3 === 0 ? 'SCORE_0' : 'SCORE_2';
  return {
    id: zoneId,
    auditId: id(0),
    zoneId,
    sequenceNo: n,
    status: n === 3 ? 'IN_PROGRESS' : 'COMPLETED',
    zoneCodeSnapshot: `Z-${n}`,
    zoneNameSnapshot: name,
    zoneDescriptionSnapshot: 'Heat treatment, shot blasting and final inspection bays, including the dispatch staging area',
    zoneLeaderUserIdSnapshot: null,
    zoneLeaderNameSnapshot: LEADER,
    checklistVersionId: VERSION,
    checklistTemplateNameSnapshot: 'Production shop floor',
    zoneRemark: 'Good progress on visual controls; shadow boards missing at two presses.',
    overallActionSuggestions: [],
    totals: n === 1 ? totals(26, 40) : totals(34, 50),
    sections: SECTIONS.map((section) =>
      n === 1 && section === 'S2_SET_IN_ORDER'
        ? { section, raw: 0, max: 0, pct: null }
        : { section, raw: 7, max: 10, pct: 70 },
    ),
    resumeQuestionId: null,
    startedAt: at(30),
    completedAt: at(2),
    clientUpdatedAt: at(2),
    version: 1,
    responses: QUESTIONS.map((question, index) => ({
      id: id(10_000 * n + index),
      auditZoneId: zoneId,
      auditId: id(0),
      checklistQuestionId: question.id,
      section: question.section,
      globalOrder: question.globalOrder,
      value: value(index),
      numericScore: value(index) === 'NA' ? null : value(index) === 'SCORE_2' ? 2 : 0,
      remark: index % 9 === 0 ? 'शेल्फ पर लेबल नहीं है; पुराने डाई अभी भी रैक पर रखे हैं।' : null,
      answeredAt: at(3),
      clientUpdatedAt: at(3),
      syncState: 'SYNCED',
    })),
  };
}

const ZONES = [
  zone(1, 'भट्टी और ताप उपचार विभाग — मुख्य उत्पादन क्षेत्र'),
  zone(2, 'Raw Material Receiving, Inspection, Quarantine & Long-Term Storage Warehouse Bay'),
  zone(3, 'Z'),
];

/** The fixture's answer for a read the screen makes; `undefined` falls through to the API. */
export function worstCase(path: string): unknown {
  if (path.startsWith('/audits?')) {
    return { data: Array.from({ length: 1000 }, (_, n) => audit(n)), nextCursor: null };
  }
  if (path.startsWith('/audit-assignments?')) return { data: [], nextCursor: null };
  if (path.startsWith('/checklist-versions/')) {
    return { id: VERSION, templateName: 'Production shop floor', status: 'PUBLISHED', questions: QUESTIONS };
  }
  if (/^\/audits\/[^/?]+\/summary/.test(path)) {
    return {
      audit: { auditId: id(0), auditZoneId: null, totals: totals(60, 90), sections: [] },
      zones: ZONES.map((z) => ({ auditId: id(0), auditZoneId: z.id, totals: z.totals, sections: z.sections })),
    };
  }
  if (/^\/audits\/[^/?]+\/evidence/.test(path)) {
    return {
      data: [
        { id: id(1), kind: 'AUDITOR_SELFIE', auditZoneId: null, questionResponseId: null, classification: 'NEUTRAL', isSummaryFlagged: false, remark: null, mediaProcessedAt: at(1) },
        ...ZONES.flatMap((z) =>
          z.responses.slice(0, 4).map((response) => ({
            id: id(20_000 + Number.parseInt(response.id.slice(-6), 16)),
            kind: 'QUESTION_EVIDENCE',
            auditZoneId: z.id,
            questionResponseId: response.id,
            classification: response.value === 'SCORE_0' ? 'NONCONFORMITY' : 'GOOD',
            isSummaryFlagged: false,
            remark: response.remark,
            mediaProcessedAt: at(1),
          })),
        ),
      ],
      nextCursor: null,
    };
  }
  const detail = /^\/audits\/([^/?]+)$/.exec(path);
  if (detail) {
    const n = Number.parseInt(detail[1]!.slice(-12), 16);
    return { ...audit(Number.isNaN(n) ? 0 : n), unitName: UNIT, auditorName: AUDITOR, zones: ZONES, scored: true, startedAt: at(30), completedAt: null, pauseReason: null };
  }
  return undefined;
}
