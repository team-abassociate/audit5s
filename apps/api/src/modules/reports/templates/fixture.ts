import {
  REPORT_PAYLOAD_SCHEMA_VERSION,
  type ReportNonconformity,
  type ReportPayload,
  type ReportPhoto,
  type ReportQuestion,
  type ReportZone,
  type SSection,
} from '@audit5s/contracts';
import { BRAND_TOKENS, RATING_BANDS, RESPONSE_TOKENS, S_SECTION_ORDER } from '@audit5s/domain';

/**
 * **The fixed payload** the byte-stability suite renders (PART 15.7).
 *
 * Every value in it is a literal. Nothing is read from a clock, a random source, a
 * database or the filesystem — because the assertion the suite makes is that this payload
 * produces the same PDF twice, and a fixture with a `new Date()` in it would fail that for
 * a reason that has nothing to do with the renderer.
 *
 * It is deliberately a *hard* case rather than a tidy one: a fully-NA section (D4), a
 * redacted photograph (R-5), one nonconformity answered with Option A and one with Option
 * B, one still open, and an unanswered question. A fixture where everything is filled in
 * would pass while the interesting branches went unrendered.
 */

const PHOTO_KEY = 'evidence/unit-1/audit-1/zone-1/good.jpg';
const BEFORE_KEY = 'evidence/unit-1/audit-1/zone-1/before.jpg';
const AFTER_KEY = 'evidence/unit-1/audit-1/zone-1/after.jpg';
const SELFIE_KEY = 'evidence/unit-1/audit-1/selfie.jpg';

function question(
  globalOrder: number,
  section: SSection,
  value: ReportQuestion['value'],
  remark: string | null = null,
): ReportQuestion {
  return {
    globalOrder,
    section,
    text: `Check point ${globalOrder} – kept clean and free of dust`,
    value,
    marks: value === null || value === 'NA' ? null : Number(value.replace('SCORE_', '')),
    remark,
  };
}

function photo(overrides: Partial<ReportPhoto> & { evidenceId: string }): ReportPhoto {
  return {
    objectKey: PHOTO_KEY,
    redacted: false,
    remark: null,
    capturedAt: '2026-03-04T06:30:00.000Z',
    isSummaryFlagged: false,
    questionGlobalOrder: 7,
    questionText: 'Check point 7 – kept clean and free of dust',
    section: 'S1_SORT',
    scoreAtCapture: 'SCORE_2',
    ...overrides,
  };
}

/** Five sections; the fifth is fully NA, so its percentage is `null` rather than zero. */
const SECTIONS = S_SECTION_ORDER.map((section, index) =>
  index === 4
    ? { section, applicable: 0, na: 10, raw: 0, max: 0, pct: null }
    : { section, applicable: 10, na: 0, raw: 15 + index, max: 20, pct: ((15 + index) / 20) * 100 },
);

const QUESTIONS: ReportQuestion[] = S_SECTION_ORDER.flatMap((section, sectionIndex) =>
  Array.from({ length: 10 }, (_, i) => {
    const globalOrder = sectionIndex * 10 + i + 1;
    if (sectionIndex === 4) return question(globalOrder, section, 'NA');
    if (i === 0) return question(globalOrder, section, 'SCORE_0', 'Spillage under the press');
    if (i === 1) return question(globalOrder, section, 'SCORE_1');
    if (i === 9) return question(globalOrder, section, null);
    return question(globalOrder, section, 'SCORE_2');
  }),
);

const NONCONFORMITIES: ReportNonconformity[] = [
  {
    ...photo({
      evidenceId: 'ev-nc-1',
      objectKey: BEFORE_KEY,
      questionGlobalOrder: 1,
      scoreAtCapture: 'SCORE_0',
      remark: 'Spillage under the press',
      isSummaryFlagged: true,
    }),
    correctiveActionId: 'ca-1',
    status: 'VERIFIED',
    dueAt: '2026-03-11T06:30:00.000Z',
    correctiveActionUrl: 'https://app.example.test/ca/FIXED-TOKEN-ONE',
    outcome: {
      option: 'COMPLETED',
      submittedByName: 'R. Deshmukh',
      submittedAt: '2026-03-06T09:00:00.000Z',
      description: 'Spillage cleared and a drip tray fitted.',
      afterPhoto: photo({
        evidenceId: 'ev-after-1',
        objectKey: AFTER_KEY,
        scoreAtCapture: null,
      }),
      explanation: null,
      verified: true,
      verifiedAt: '2026-03-07T04:00:00.000Z',
    },
  },
  {
    ...photo({
      evidenceId: 'ev-nc-2',
      objectKey: BEFORE_KEY,
      questionGlobalOrder: 11,
      section: 'S2_SET_IN_ORDER',
      scoreAtCapture: 'SCORE_1',
      remark: 'Tooling not returned to its shadow board',
    }),
    correctiveActionId: 'ca-2',
    status: 'VERIFIED',
    dueAt: '2026-03-11T06:30:00.000Z',
    correctiveActionUrl: null,
    outcome: {
      option: 'NOT_POSSIBLE',
      submittedByName: 'R. Deshmukh',
      submittedAt: '2026-03-06T09:05:00.000Z',
      description: null,
      afterPhoto: null,
      explanation: 'Requires vendor approval; PO raised 12 Sep.',
      verified: true,
      verifiedAt: '2026-03-07T04:05:00.000Z',
    },
  },
  {
    ...photo({
      evidenceId: 'ev-nc-3',
      // R-5: redacted, so the page prints the placeholder and the caption survives.
      objectKey: null,
      redacted: true,
      questionGlobalOrder: 21,
      section: 'S3_SHINE',
      scoreAtCapture: 'SCORE_0',
      remark: 'Coolant leak at the sump',
    }),
    correctiveActionId: 'ca-3',
    status: 'OPEN',
    dueAt: '2026-03-11T06:30:00.000Z',
    correctiveActionUrl: 'https://app.example.test/ca/FIXED-TOKEN-THREE',
    outcome: null,
  },
];

const ZONE: ReportZone = {
  auditZoneId: 'az-1',
  auditId: 'audit-1',
  auditType: 'EXTERNAL_5S',
  zoneCode: '1',
  zoneName: 'Press',
  zoneDescription: 'Press shop, bays 1–4',
  zoneLeaderName: 'R. Deshmukh',
  departmentName: 'Shop Floor',
  checklistVersionNo: 3,
  auditDate: '2026-03-04T06:00:00.000Z',
  auditorName: 'A. Kulkarni',
  auditorLoginId: 'AK1204',
  scored: true,
  totals: { applicableQuestions: 40, naQuestions: 10, rawScore: 66, maxScore: 80, scorePercentage: 82.5 },
  sections: SECTIONS,
  zoneRemark: 'Housekeeping has improved since the last visit; drainage remains the weak point.',
  questions: QUESTIONS,
  good: [
    photo({ evidenceId: 'ev-good-1', remark: 'Shadow board complete', isSummaryFlagged: true }),
    photo({ evidenceId: 'ev-good-2', questionGlobalOrder: 19, section: 'S2_SET_IN_ORDER' }),
  ],
  nonconformities: NONCONFORMITIES,
};

/** The initial Zone report (§4.1). Its nonconformities have no outcome rendered. */
export function fixtureZonePayload(overrides: Partial<ReportPayload> = {}): ReportPayload {
  return {
    schemaVersion: REPORT_PAYLOAD_SCHEMA_VERSION,
    kind: 'INITIAL_ZONE',
    snapshotId: '00000000-0000-7000-8000-000000000001',
    version: 1,
    generatedAt: '2026-03-08T10:00:00.000Z',
    generatedByName: 'S. Rao',
    unit: { id: 'unit-1', name: 'Pune Works', code: 'PNQ', address: 'Chakan, Pune, Maharashtra' },
    audit: {
      id: 'audit-1',
      auditType: 'EXTERNAL_5S',
      startedAt: '2026-03-04T06:00:00.000Z',
      completedAt: '2026-03-04T09:00:00.000Z',
      auditorName: 'A. Kulkarni',
      auditorLoginId: 'AK1204',
      startLatitude: 18.76,
      startLongitude: 73.86,
      locationSuspicious: false,
      selfieObjectKey: SELFIE_KEY,
    },
    zones: [ZONE],
    totals: ZONE.totals,
    sections: SECTIONS,
    auditDateRange: { from: '2026-03-04T06:00:00.000Z', to: '2026-03-04T06:00:00.000Z' },
    auditorNames: ['A. Kulkarni'],
    closure: null,
    summaryExtras: null,
    bands: RATING_BANDS.map((band) => ({ ...band })),
    responseTokens: Object.fromEntries(
      Object.entries(RESPONSE_TOKENS).map(([key, token]) => [key, { ...token }]),
    ),
    brand: { ...BRAND_TOKENS },
    ...overrides,
  };
}

/**
 * The after-evidence report of the same Zone, as version 2 (§4.2).
 *
 * **The Zone is the same object.** That is the point of the fixture: the test that asserts
 * GOOD photos are unchanged between v1 and v2 has to be given identical input, or it would
 * be asserting that two different fixtures happen to agree.
 */
export function fixtureAfterEvidencePayload(): ReportPayload {
  return fixtureZonePayload({
    kind: 'AFTER_EVIDENCE_ZONE',
    version: 2,
    snapshotId: '00000000-0000-7000-8000-000000000002',
    closure: {
      nonconformities: 3,
      closed: 1,
      notPossible: 1,
      open: 1,
      closureRatePercentage: 66.667,
      averageClosureHours: 23.5,
    },
  });
}

/** A two-Zone summary (§4.3), the second Zone weaker so the rankings have an order. */
export function fixtureSummaryPayload(): ReportPayload {
  const second: ReportZone = {
    ...ZONE,
    auditZoneId: 'az-2',
    zoneCode: '2',
    zoneName: 'Assembly',
    totals: { applicableQuestions: 40, naQuestions: 10, rawScore: 40, maxScore: 80, scorePercentage: 50 },
    sections: SECTIONS.map((section, index) =>
      index === 4 ? section : { ...section, raw: 10, pct: 50 },
    ),
    good: [photo({ evidenceId: 'ev-good-3', isSummaryFlagged: true })],
    nonconformities: [NONCONFORMITIES[2]!],
  };

  // Summed, not averaged — the same arithmetic `freezePayload` does (§10.3-C). Written out
  // here rather than hard-coded so the fixture cannot quietly disagree with the rule the
  // test is about.
  const summed = S_SECTION_ORDER.map((section) => {
    const parts = [ZONE, second].map((zone) => zone.sections.find((s) => s.section === section)!);
    const raw = parts.reduce((sum, part) => sum + part.raw, 0);
    const max = parts.reduce((sum, part) => sum + part.max, 0);
    return {
      section,
      applicable: parts.reduce((sum, part) => sum + part.applicable, 0),
      na: parts.reduce((sum, part) => sum + part.na, 0),
      raw,
      max,
      pct: max === 0 ? null : Math.round((raw / max) * 100_000) / 1000,
    };
  });
  const rawScore = summed.reduce((sum, s) => sum + s.raw, 0);
  const maxScore = summed.reduce((sum, s) => sum + s.max, 0);

  return fixtureZonePayload({
    kind: 'MULTI_ZONE_SUMMARY',
    snapshotId: '00000000-0000-7000-8000-000000000003',
    zones: [ZONE, second],
    audit: null,
    sections: summed,
    totals: {
      applicableQuestions: 80,
      naQuestions: 20,
      rawScore,
      maxScore,
      scorePercentage: Math.round((rawScore / maxScore) * 100_000) / 1000,
    },
    auditorNames: ['A. Kulkarni'],
    summaryExtras: {
      highest: [{ zoneCode: '1', zoneName: 'Press', pct: 82.5 }],
      lowest: [{ zoneCode: '2', zoneName: 'Assembly', pct: 50, weakestSection: 'S1_SORT' }],
      histogram: RATING_BANDS.map((band) => ({
        token: band.token,
        label: band.label,
        count: band.token === 'band-on-track' ? 1 : band.token === 'band-needs-support' ? 1 : 0,
      })),
      nonconformitySummary: {
        open: 2,
        submitted: 0,
        verified: 2,
        recurrent: [
          { questionGlobalOrder: 21, questionText: 'Check point 21 – kept clean and free of dust', zones: 2 },
        ],
      },
    },
  });
}

/** A tiny 1×1 JPEG, so a render has real image bytes without reading the filesystem. */
export const FIXTURE_IMAGE_DATA_URI =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL' +
  'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

export const FIXTURE_IMAGE_KEYS = [PHOTO_KEY, BEFORE_KEY, AFTER_KEY, SELFIE_KEY] as const;
