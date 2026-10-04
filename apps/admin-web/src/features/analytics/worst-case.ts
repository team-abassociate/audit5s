/**
 * Development only: Analytics at its worst (`/analytics?data=worst`, loaded by
 * `AnalyticsPage`'s `get` / `all`). Long Unit, Zone and auditor names, Hindi and Marathi
 * Zones, 40 Units with unranked, N/A, 0 and 100 scores, 1,284 audits conducted, 30 audits
 * of one Unit (four on one day, one walk-by), an all-N/A section, a Unit's first audit
 * with no previous one for one S, and 0 / 1 / 1,284 corrective-action counts.
 */
import type { SSection } from '@audit5s/contracts';

const UNIT = 'Shree Venkateshwara Precision Forgings & Auto Components Pvt Ltd';
const AUDITOR = 'Mr. Venkataraghavan Subramaniam-Iyengar & Mrs. Priyadarshini Ramachandran';
const SECTIONS: SSection[] = ['S1_SORT', 'S2_SET_IN_ORDER', 'S3_SHINE', 'S4_STANDARDIZE', 'S5_SUSTAIN'];

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number, hours = 0) => new Date(NOW - days * DAY - hours * 3_600_000).toISOString();

const UNIT_NAMES = [
  UNIT,
  'कोल्हापूर फाउंड्री अँड इंजिनिअरिंग वर्क्स',
  'A1',
  'Bharat Heavy Castings — Plant 2 (Pithampur SEZ, Phase III)',
];
/** [score, scored audits]; rank is null below 3 scored audits, as the API does. */
const UNIT_SCORES: Array<[number | null, number]> = [
  [41.237, 1284], [59.994, 3], [100, 12], [0, 4], [null, 0], [89.95, 2], [90, 9], [74.999, 5],
];
const units = Array.from({ length: 40 }, (_, n) => ({
  id: id(100 + n),
  name: UNIT_NAMES[n] ?? `Unit ${n + 1}`,
  score: UNIT_SCORES[n] ?? [Math.round((40 + ((n * 37) % 60)) * 10) / 10, 3 + (n % 5)],
}));
const ranked = [...units]
  .filter((unit) => unit.score[1] >= 3 && unit.score[0] !== null)
  .sort((a, b) => b.score[0]! - a.score[0]!);

/** [name, all-NA S3?]; the Zone codes are Z-01… in this order. */
const ZONES: Array<[string, boolean]> = [
  ['Raw Material Stores — Forging Billets, Dies & Consumables (Bay 3, Mezzanine)', false],
  ['कच्चा माल भंडार क्षेत्र', false],
  ['तयार माल गोदाम आणि पाठवणी विभाग', false],
  ['Zone with an all-N/A section', true],
  ['Heat Treatment', false],
  ['Machine Shop', false],
  ['Paint Shop', false],
  ['Assembly Line 1', false],
  ['Assembly Line 2', false],
  ['Quality Lab', false],
  ['Tool Room', false],
  ['Canteen', false],
  ['Utilities', false],
  ['Dispatch', false],
  ['Q', false],
];
const ZONE_SCORES = [38.5, 59.994, 74.999, 66.7, 92.5, 100, 0, 85, 72.1, 90.4, 58.2, 96, 68, 81.3, 77.7];

function sections(base: number | null, allNaS3: boolean) {
  return SECTIONS.map((section, s) => {
    const na = allNaS3 && section === 'S3_SHINE';
    const pct = na || base === null ? null : Math.max(0, Math.min(100, base + (s - 2) * 6));
    return { section, applicable: na ? 0 : 8, na: na ? 8 : 0, raw: pct === null ? 0 : Math.round(pct * 0.16), max: na ? 0 : 16, pct };
  });
}
const totals = (pct: number | null) => ({
  applicableQuestions: 40,
  naQuestions: 8,
  rawScore: Math.round((pct ?? 0) * 0.8),
  maxScore: 80,
  scorePercentage: pct,
});

/** 30 audits of the Unit, the newest four on one day; one walk-by. */
const AUDITS = Array.from({ length: 30 }, (_, n) => {
  const walkBy = n === 6;
  const pct = walkBy ? null : 45 + ((n * 17) % 50) + 0.37;
  return {
    id: id(5000 + n),
    unitId: id(100),
    unitName: UNIT,
    auditType: walkBy ? 'WALK_BY' : 'EXTERNAL_5S',
    scored: !walkBy,
    status: 'CLOSED',
    auditorName: AUDITOR,
    completedAt: ago(n < 4 ? 2 : n * 12, n < 4 ? n * 3 : 0),
    totals: totals(pct),
  };
});

/**
 * One line per Unit: none, one, two and thirty audits; 0 and 100; a flat line; rises and
 * falls. Sorted as the API sorts — most improved first, no change last by name.
 */
const unitTrends = units
  .map((unit, n) => {
    const count = [30, 0, 1, 2, 3, 12][n] ?? 2 + (n % 6);
    const points = Array.from({ length: count }, (_, k) => ({
      auditId: id(60000 + n * 100 + k),
      completedAt: ago((count - k) * 11 + (n % 9)),
      scorePercentage: n === 2 ? 100 : n === 3 ? 0 : n === 6 ? 74.999 : Math.min(100, Math.max(0, 40 + ((n * 13 + k * (n % 7 - 2) * 9) % 61) + 0.37)),
    }));
    const window = points.slice(-3);
    const change = window.length > 1 ? window.at(-1)!.scorePercentage - window[0]!.scorePercentage : null;
    return { unitId: unit.id, unitName: unit.name, points, change, changeFrom: change === null ? null : window[0]!.completedAt };
  })
  .sort((a, b) => (a.change === b.change ? a.unitName.localeCompare(b.unitName) : (b.change ?? -Infinity) - (a.change ?? -Infinity)));

function summary(auditId: string) {
  const audit = AUDITS.find((candidate) => candidate.id === auditId) ?? AUDITS[0]!;
  const zones = ZONES.map(([name, allNaS3], index) => {
    const pct = audit.scored ? ZONE_SCORES[index]! : null;
    return {
      auditId: audit.id,
      auditZoneId: id(9000 + index),
      totals: totals(pct),
      sections: sections(pct, allNaS3),
      zoneCode: `Z-${String(index + 1).padStart(2, '0')}`,
      zoneName: name,
      zoneDescription: null,
      checklistTemplateName: 'Forging shop 5S',
      status: 'COMPLETED',
    };
  });
  return {
    scored: audit.scored,
    audit: {
      auditId: audit.id,
      auditZoneId: null,
      totals: audit.totals,
      sections: sections(audit.totals.scorePercentage, true),
    },
    zones,
  };
}

/** 1,284 corrective actions on the audit, one of them closed, spread over the Zones. */
const actions = (auditId: string) =>
  Array.from({ length: 1284 }, (_, n) => ({
    id: id(20000 + n),
    auditId,
    zoneCode: `Z-${String((n % 3) + 1).padStart(2, '0')}`,
    status: n === 0 ? 'VERIFIED' : 'OPEN',
  }));

export function worstCase(path: string): unknown {
  const [route = '', query = ''] = path.split('?');
  const params = new URLSearchParams(query);

  if (route === '/units') return units.map(({ id: unitId, name }) => ({ id: unitId, name, status: 'ACTIVE' }));
  if (route === '/users') {
    return Array.from({ length: 41 }, (_, n) => ({
      id: id(300 + n),
      role: n === 0 ? 'COORDINATOR' : 'CONSULTANT',
      status: 'ACTIVE',
    }));
  }
  if (route === '/audits' && params.get('unitId')) return AUDITS;
  if (route === '/audits') {
    return Array.from({ length: 1290 }, (_, n) => ({
      id: id(40000 + n),
      completedAt: n < 6 ? null : ago(n % 700),
    }));
  }
  if (route === '/analytics/organization/overview') {
    return {
      auditCount: 1290,
      completedCount: 1284,
      score: { rawScore: 0, maxScore: 0, scorePercentage: 71.4, sampleCount: 1284 },
      openNonconformities: 1284,
      closedNonconformities: 1,
      closureRatePercentage: 0.08,
      averageClosureHours: null,
      activeAuditors: 40,
      unitRanking: units.map((unit) => ({
        unitId: unit.id,
        unitName: unit.name,
        rank: ranked.includes(unit) ? ranked.indexOf(unit) + 1 : null,
        score: { rawScore: 0, maxScore: 0, scorePercentage: unit.score[0], sampleCount: unit.score[1] },
      })),
      syncHealth: { devicesWithUnsyncedData: 0, deadLetterCount: 0, oldestPendingAt: null },
    };
  }
  if (route === '/analytics/organization/unit-trends') return unitTrends;
  const audit = /^\/audits\/([^/]+)\/summary$/.exec(route);
  if (audit) return summary(audit[1]!);
  if (route === '/corrective-actions') return actions(params.get('auditId') ?? '');
  if (/^\/analytics\/units\/[^/]+\/sections$/.test(route)) {
    return {
      unitId: id(100),
      radar: SECTIONS.map((section, s) => ({
        section,
        // S4 all N/A in the latest audit; S5 has no previous audit to compare against.
        currentScorePercentage: s === 3 ? null : [41.2, 100, 0, 0, 59.994][s]!,
        previousScorePercentage: s === 4 ? null : [38.9, 92.5, 12.4, 70, 0][s]!,
        sampleCount: s === 0 ? 1284 : s,
      })),
      trend: [],
    };
  }
  if (route === '/analytics/corrective-actions/closure') {
    return {
      opened: 1284,
      submitted: 1,
      resolved: 0,
      closureRatePercentage: 0,
      averageClosureHours: null,
      byUnit: [],
      byZone: [],
      byLeader: [],
    };
  }
  throw new Error(`No worst-case fixture for ${path}`);
}
