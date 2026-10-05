/**
 * Development only: the Unit board at its worst (`/dashboard?data=worst`, loaded by
 * `DashboardPage`'s `get`). Long Unit, Zone and leader names, Hindi and Marathi Zones, an
 * all-N/A section, a pending Zone, one awaiting the rollup, 0 / 1 / 1,284 open findings,
 * four audits on one day, one question photographed three times, and an action list that
 * fills the API's 200-row page.
 */
import type { CorrectiveAction, SSection } from '@audit5s/contracts';
import { summarize } from '@/features/corrective-actions/worst-case';

const UNIT_ID = '00000000-0000-4000-8000-00000000b0a2';
const UNIT = 'Shree Venkateshwara Precision Forgings & Auto Components Pvt Ltd';
const LEADER = 'Mr. Venkataraghavan Subramaniam-Iyengar & Mrs. Priyadarshini Ramachandran';
const AUDITOR = 'Priyadarshini Ramachandran-Venkataraghavan';
const QUESTION =
  'Loading / unloading dock area is free of unwanted material, pallets are stacked in marked locations and the floor markings are visible';
const SECTIONS: SSection[] = ['S1_SORT', 'S2_SET_IN_ORDER', 'S3_SHINE', 'S4_STANDARDIZE', 'S5_SUSTAIN'];

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number, hours = 0) => new Date(NOW - days * DAY - hours * 3_600_000).toISOString();

/** [name, leader, weighted, latest, open NCs]; `null` weighted = never audited in the period. */
const ZONES: Array<[string, string | null, number | null, number | null, number]> = [
  ['Raw Material Stores — Forging Billets, Dies & Consumables (Bay 3, Mezzanine)', LEADER, 41.237, 38.5, 1284],
  ['कच्चा माल भंडार क्षेत्र', 'रामेश्वर प्रसाद त्रिपाठी', 59.994, 62.1, 1],
  ['तयार माल गोदाम आणि पाठवणी विभाग', null, 74.999, 71.4, 0],
  ['Heat Treatment', 'P. Menon', 90, 92.5, 0],
  ['Zone with an all-N/A section', 'S. Rao', 66.7, 66.7, 3],
  ['Machine Shop', 'A. Bagde', 100, 100, 0],
  ['Paint Shop', 'K. Iyer', 0, 0, 12],
  ['Assembly Line 1', 'M. Patil', 82.3, 85, 4],
  ['Assembly Line 2', null, 77.6, 72.1, 7],
  ['Quality Lab', 'R. Kumar', 88.2, 90.4, 2],
  ['Tool Room', 'D. Joshi', 63.5, 58.2, 5],
  ['Canteen', 'F. Shaikh', 95.1, 96, 0],
  ['Utilities', 'H. Desai', 70.2, 68, 1],
  ['Never audited', null, null, null, 0],
  ['Awaiting rollup', 'G. Nair', null, null, 0],
];
const code = (index: number) => `Z-${String(index + 1).padStart(2, '0')}`;
const AUDITED = ZONES.map((zone, index) => ({ zone, index })).filter(({ zone }) => zone[2] !== null);

const metric = (pct: number | null) => ({ rawScore: pct ?? 0, maxScore: 100, scorePercentage: pct, sampleCount: 3 });
const totals = (pct: number | null) => ({
  applicableQuestions: 40,
  naQuestions: 0,
  rawScore: Math.round((pct ?? 0) * 0.8),
  maxScore: 80,
  scorePercentage: pct,
});

function sections(index: number, base: number) {
  return SECTIONS.map((section, s) => {
    const na = index === 4 && section === 'S3_SHINE';
    const pct = na ? null : Math.max(0, Math.min(100, base + (s - 2) * 7 + (index % 3) * 3));
    return { section, applicable: na ? 0 : 8, na: na ? 8 : 0, raw: 0, max: 16, pct };
  });
}

/** 24 scored audits over the year, the newest four on one day; one walk-by. */
const AUDITS = Array.from({ length: 25 }, (_, n) => {
  const daysAgo = n < 4 ? 2 : n * 14;
  const walkBy = n === 6;
  const pct = walkBy ? null : 45 + ((n * 17) % 50) + 0.37;
  return {
    id: id(5000 + n),
    unitId: UNIT_ID,
    unitName: UNIT,
    auditType: walkBy ? 'WALK_BY' : 'EXTERNAL_5S',
    scored: !walkBy,
    status: n % 3 === 0 ? 'CORRECTIVE_ACTION_OPEN' : 'CLOSED',
    auditorName: AUDITOR,
    completedAt: ago(daysAgo, n < 4 ? n * 3 : 0),
    totals: totals(pct),
  };
});

function summary(auditId: string) {
  const audit = AUDITS.find((candidate) => candidate.id === auditId);
  const n = Number.parseInt(auditId.slice(-4), 16) - 5000;
  const covered = [...AUDITED, { zone: ZONES[14]!, index: 14 }].filter(({ index }) => (index + n) % 2 === 0 || n > 3);
  return {
    scored: audit?.scored ?? true,
    audit: { auditId, auditZoneId: null, totals: audit?.totals ?? totals(null), sections: sections(0, 70) },
    zones: covered.map(({ zone, index }) => ({
      auditId,
      auditZoneId: id(7000 + index),
      totals: totals(zone[3] ?? 64),
      sections: sections(index, zone[3] ?? 64),
      zoneCode: code(index),
      zoneName: zone[0],
      checklistTemplateName: null,
      status: 'COMPLETED',
    })),
  };
}

const STATUSES = ['OPEN', 'OPEN', 'REOPENED', 'ACTION_SUBMITTED', 'NOT_POSSIBLE', 'VERIFIED', 'WITHDRAWN'];

/** 200 rows — the API's page — and a cursor saying more exist. */
const ACTIONS = Array.from({ length: 200 }, (_, n) => {
  const zoneIndex = n < 120 ? 0 : [1, 4, 6, 7, 8, 9, 10, 12][n % 8]!;
  const status = STATUSES[n % STATUSES.length]!;
  return {
    id: id(9000 + n),
    evidenceId: id(11000 + n),
    suggestion: null,
    suggestionNo: null,
    auditId: AUDITS[Math.floor(n / 3) % 4]!.id,
    auditZoneId: id(7000 + zoneIndex),
    unitId: UNIT_ID,
    zoneId: id(100 + zoneIndex),
    // Every three in a row share a question: one finding, three photographs (B12).
    checklistQuestionId: n % 11 === 10 ? null : id(20000 + Math.floor(n / 3)),
    status,
    assignedZoneLeaderUserId: null,
    assignedZoneLeaderName: n % 5 === 0 ? LEADER : null,
    dueAt: n % 13 === 12 ? null : ago(n % 4 === 0 ? 9 : -3),
    openedAt: ago(14 + (n % 9)),
    lastSubmittedAt: null,
    resolvedAt: status === 'VERIFIED' ? ago(3) : null,
    verifiedByUserId: null,
    reopenCount: 0,
    version: 1,
    auditType: 'EXTERNAL_5S',
    auditorUserId: id(3),
    auditorName: AUDITOR,
    zoneCode: code(zoneIndex),
    zoneName: ZONES[zoneIndex]![0],
    section: SECTIONS[n % 5],
    questionGlobalOrder: n,
    questionText: n % 11 === 10 ? null : `${QUESTION} (#${Math.floor(n / 3) + 1})`,
    scoreAtCapture: n % 2 === 0 ? 'SCORE_0' : 'SCORE_1',
    findingRemark: n % 11 === 10 ? 'टूटी हुई पैलेट रैक, तुरंत बदलें' : null,
    auditCompletedAt: AUDITS[Math.floor(n / 3) % 4]!.completedAt,
  };
});

export function worstCase(path: string): unknown {
  if (path.startsWith('/units?')) return { data: [{ id: UNIT_ID, name: UNIT }], nextCursor: null };
  if (path.includes('/overview')) {
    return {
      unitId: UNIT_ID,
      auditCount: 25,
      completedCount: 24,
      zoneCount: ZONES.length,
      score: metric(57.6849),
      openNonconformities: 1284,
      closedNonconformities: 1,
      closureRatePercentage: 0.08,
      averageClosureHours: 1234.56,
      activeAuditors: 1,
    };
  }
  if (path.includes('/zones/ranking')) {
    return AUDITED.map(({ zone, index }) => ({
      zoneId: id(100 + index),
      zoneCode: code(index),
      zoneName: zone[0],
      rank: null,
      score: metric(zone[2]),
      lastScore: zone[3],
      previousScore: zone[3] === null ? null : zone[3] - 4,
      improvement: index % 2 === 0 ? -4.05 : 0,
      auditCount: 1 + (index % 4),
      lastAuditAt: ago(2),
      daysSinceLastAudit: 2,
      dominantWeakSection: 'S3_SHINE',
      openNonconformities: zone[4],
    })).sort((a, b) => (a.score.scorePercentage ?? 0) - (b.score.scorePercentage ?? 0));
  }
  if (path.includes('/zones')) {
    return {
      data: ZONES.map((zone, index) => ({
        id: id(100 + index),
        unitId: UNIT_ID,
        code: code(index),
        name: zone[0],
        zoneLeaderName: zone[1],
        archivedAt: null,
      })),
      nextCursor: null,
    };
  }
  if (path.endsWith('/summary')) return summary(path.split('/')[2]!);
  if (path.startsWith('/audits?')) return { data: AUDITS, nextCursor: null };
  if (path.startsWith('/corrective-actions/summary')) return summarize(ACTIONS as unknown as CorrectiveAction[], Date.now());
  if (path.startsWith('/corrective-actions?')) {
    const params = new URLSearchParams(path.split('?')[1]);
    const zoneId = params.get('zoneId');
    const rows = zoneId ? ACTIONS.filter((action) => action.zoneId === zoneId) : ACTIONS;
    return { data: rows.slice(0, Number(params.get('limit') ?? rows.length)), nextCursor: null };
  }
  return undefined;
}
