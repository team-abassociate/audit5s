import {
  REPORT_PAYLOAD_SCHEMA_VERSION,
  type ReportClosure,
  type ReportKind,
  type ReportNonconformity,
  type ReportPayload,
  type ReportPhoto,
  type ReportQuestion,
  type ReportSummaryExtras,
  type ReportZone,
  type SectionScorePayload,
  type SSection,
} from '@audit5s/contracts';
import {
  BRAND_TOKENS,
  RATING_BANDS,
  RESPONSE_TOKENS,
  S_SECTION_ORDER,
  bandFor,
  percentageOf,
} from '@audit5s/domain';
import type { ReportsRepository } from './reports.repository';

/**
 * Freezing a payload (§10.1, §10.2).
 *
 * Everything here is a pure transformation of rows already read. It is separate from the
 * repository and from the service for one reason: the byte-stability test (PART 15.7)
 * needs a payload it can hand straight to the renderer, and a freeze that could only be
 * produced by a live database would make that test a database test.
 *
 * Two rules are load-bearing and easy to get wrong:
 *
 *   * **Aggregation is `Σachieved / Σmax`, never the mean of percentages** (§10.3-C,
 *     confirmed by the sample: 1280 / 2092 = 61.2 %). Averaging zone percentages weights a
 *     ten-question walk-through the same as a fifty-question audit and produces a number
 *     the business did not agree to.
 *   * **A fully-NA section is `null`, not zero** (D4). It prints `N/A` and is excluded from
 *     its parent — `bandFor(null)` is `null`, which is why that function refuses to fall
 *     through to "Needs Support".
 */

type Rows<M extends keyof ReportsRepository> = Awaited<
  ReturnType<ReportsRepository[M] extends (...args: never[]) => unknown ? ReportsRepository[M] : never>
>;

export interface FreezeInput {
  kind: ReportKind;
  snapshotId: string;
  version: number;
  generatedAt: Date;
  generatedByName: string;
  unit: NonNullable<Rows<'readUnit'>>;
  zones: Rows<'readZones'>;
  sectionScores: Rows<'readSectionScores'>;
  responses: Rows<'readResponses'>;
  photos: Rows<'readPhotos'>;
  actions: Rows<'readCorrectiveActions'>;
  /** Null on a summary — §4.3 item 9: no auditor selfie in the summary. */
  selfieObjectKey: string | null;
  /** `correctiveActionId → /ca/{token}`. Minted before the render, frozen here (R-14). */
  actionUrls: ReadonlyMap<string, string>;
}

export function freezePayload(input: FreezeInput): ReportPayload {
  const zones = input.zones.map((zone) => buildZone(zone, input));
  const scoredZones = zones.filter((zone) => zone.scored);

  // Σachieved / Σmax over the selected Zones only. A walk-by contributes nothing, which is
  // PART 11's "walk-by audits are excluded from every score metric" applied at the source
  // rather than remembered by each reader.
  const sections = sumSectionsAcross(scoredZones);
  const rawScore = sections.reduce((sum, section) => sum + section.raw, 0);
  const maxScore = sections.reduce((sum, section) => sum + section.max, 0);

  const isSummary = input.kind === 'MULTI_ZONE_SUMMARY';
  const auditDates = zones
    .map((zone) => zone.auditDate)
    .filter((date): date is string => date !== null)
    .sort();
  const auditorNames = [...new Set(zones.map((zone) => zone.auditorName))].sort();

  // A zone report has one audit; a summary spanning one audit still has one, and naming it
  // is more useful than blanking the block because the selection *could* have spanned more.
  const single = isSummary && new Set(zones.map((zone) => zone.auditId)).size !== 1 ? null : zones[0];

  return {
    schemaVersion: REPORT_PAYLOAD_SCHEMA_VERSION,
    kind: input.kind,
    snapshotId: input.snapshotId,
    version: input.version,
    generatedAt: input.generatedAt.toISOString(),
    generatedByName: input.generatedByName,
    unit: {
      id: input.unit.id,
      name: input.unit.name,
      address: joinAddress(input.unit),
    },
    audit: single
      ? {
          id: single.auditId,
          auditType: single.auditType,
          startedAt: single.auditDate,
          completedAt: single.auditDate,
          auditorName: single.auditorName,
          auditorLoginId: single.auditorLoginId,
          startLatitude: null,
          startLongitude: null,
          locationSuspicious: false,
          selfieObjectKey: isSummary ? null : input.selfieObjectKey,
        }
      : null,
    zones,
    totals: {
      applicableQuestions: scoredZones.reduce((sum, z) => sum + z.totals.applicableQuestions, 0),
      naQuestions: scoredZones.reduce((sum, z) => sum + z.totals.naQuestions, 0),
      rawScore,
      maxScore,
      scorePercentage: percentageOf(rawScore, maxScore),
    },
    sections,
    auditDateRange:
      auditDates.length > 0
        ? { from: auditDates[0]!, to: auditDates[auditDates.length - 1]! }
        : null,
    auditorNames,
    closure: input.kind === 'AFTER_EVIDENCE_ZONE' ? closureOf(zones) : null,
    summaryExtras: isSummary ? summaryExtrasOf(zones) : null,
    // Frozen with the report, so one reopened in December keeps the palette it was issued
    // with even if the business repaints the scale in the meantime (§10.2).
    bands: RATING_BANDS.map((band) => ({ ...band })),
    responseTokens: Object.fromEntries(
      Object.entries(RESPONSE_TOKENS).map(([key, token]) => [key, { ...token }]),
    ),
    brand: { ...BRAND_TOKENS },
  };
}

// ------------------------------------------------------------------------------- zones

function buildZone(zone: FreezeInput['zones'][number], input: FreezeInput): ReportZone {
  const scored = zone.auditType !== 'WALK_BY';

  const sections = S_SECTION_ORDER.map((section) => {
    const row = input.sectionScores.find(
      (score) => score.auditZoneId === zone.auditZoneId && score.section === section,
    );
    return {
      section,
      applicable: row?.applicable ?? 0,
      na: row?.na ?? 0,
      raw: row?.raw ?? 0,
      max: row?.max ?? 0,
      pct: row?.pct === null || row?.pct === undefined ? null : Number(row.pct),
    } satisfies SectionScorePayload;
  });

  const questions: ReportQuestion[] = input.responses
    .filter((response) => response.auditZoneId === zone.auditZoneId)
    .map((response) => ({
      globalOrder: response.globalOrder,
      section: response.section,
      text: response.text,
      value: response.value,
      marks: response.marks ?? null,
      remark: response.remark,
    }));

  const photos = input.photos.filter((photo) => photo.auditZoneId === zone.auditZoneId);
  const actionByEvidence = new Map(input.actions.map((action) => [action.evidenceId, action]));

  return {
    auditZoneId: zone.auditZoneId,
    auditId: zone.auditId,
    auditType: zone.auditType,
    zoneCode: zone.zoneCode,
    zoneName: zone.zoneName,
    zoneDescription: zone.zoneDescription,
    zoneLeaderName: zone.zoneLeaderName,
    departmentName: zone.departmentName,
    checklistVersionNo: zone.checklistVersionNo,
    auditDate: (zone.auditCompletedAt ?? zone.completedAt ?? zone.auditStartedAt)?.toISOString() ?? null,
    auditorName: zone.auditorName,
    auditorLoginId: zone.auditorLoginId,
    scored,
    totals: {
      applicableQuestions: scored ? zone.applicableQuestions : 0,
      naQuestions: scored ? zone.naQuestions : 0,
      rawScore: scored ? zone.rawScore : 0,
      maxScore: scored ? zone.maxScore : 0,
      scorePercentage: scored && zone.scorePercentage !== null ? Number(zone.scorePercentage) : null,
    },
    sections,
    zoneRemark: zone.zoneRemark,
    questions,
    good: photos.filter((photo) => photo.classification === 'GOOD').map(toPhoto),
    nonconformities: photos
      .filter((photo) => photo.classification === 'NONCONFORMITY')
      .map((photo) => toNonconformity(photo, actionByEvidence.get(photo.id), input.actionUrls)),
  };
}

/**
 * A photograph. `objectKey` is null once redacted (R-5) and the renderer prints the
 * placeholder with "Photo removed" — the caption, the remark and the finding all stay.
 */
function toPhoto(photo: FreezeInput['photos'][number]): ReportPhoto {
  return {
    evidenceId: photo.id,
    objectKey: photo.redactedAt ? null : photo.objectKey,
    redacted: photo.redactedAt !== null,
    remark: photo.remark,
    capturedAt: photo.capturedAt?.toISOString() ?? null,
    isSummaryFlagged: photo.isSummaryFlagged,
    questionGlobalOrder: photo.questionGlobalOrder,
    questionText: photo.questionText,
    section: photo.section,
    scoreAtCapture: photo.scoreAtCapture,
  };
}

function toNonconformity(
  photo: FreezeInput['photos'][number],
  action: FreezeInput['actions'][number] | undefined,
  urls: ReadonlyMap<string, string>,
): ReportNonconformity {
  const base = toPhoto(photo);
  if (!action) {
    // A nonconformity with no action is only reachable before completion, and a report is
    // only generated after it. Rendering the finding without a button beats omitting the
    // finding, so this degrades rather than throwing.
    return {
      ...base,
      correctiveActionId: photo.id,
      status: 'OPEN',
      dueAt: null,
      correctiveActionUrl: null,
      outcome: null,
    };
  }

  const verified = action.status === 'VERIFIED';
  return {
    ...base,
    correctiveActionId: action.id,
    status: action.status,
    dueAt: action.dueAt?.toISOString() ?? null,
    correctiveActionUrl: urls.get(action.id) ?? null,
    outcome: action.submissionOption
      ? {
          option: action.submissionOption,
          submittedByName: action.submittedByName ?? '',
          submittedAt: (action.submittedAt ?? action.openedAt).toISOString(),
          description: action.description,
          afterPhoto: action.afterEvidenceId
            ? {
                evidenceId: action.afterEvidenceId,
                objectKey: action.afterRedactedAt ? null : action.afterObjectKey,
                redacted: action.afterRedactedAt !== null,
                remark: null,
                capturedAt: action.afterCapturedAt?.toISOString() ?? null,
                isSummaryFlagged: false,
                questionGlobalOrder: base.questionGlobalOrder,
                questionText: base.questionText,
                section: base.section,
                scoreAtCapture: null,
              }
            : null,
          explanation: action.explanation,
          verified,
          verifiedAt: action.resolvedAt?.toISOString() ?? null,
        }
      : null,
  };
}

// ------------------------------------------------------------------------ aggregations

/** §10.3-C: summed achieved over summed applicable max, per S, across the selection. */
function sumSectionsAcross(zones: readonly ReportZone[]): SectionScorePayload[] {
  return S_SECTION_ORDER.map((section) => {
    const parts = zones.map((zone) => zone.sections.find((s) => s.section === section));
    const applicable = parts.reduce((sum, part) => sum + (part?.applicable ?? 0), 0);
    const na = parts.reduce((sum, part) => sum + (part?.na ?? 0), 0);
    const raw = parts.reduce((sum, part) => sum + (part?.raw ?? 0), 0);
    const max = parts.reduce((sum, part) => sum + (part?.max ?? 0), 0);
    return { section, applicable, na, raw, max, pct: percentageOf(raw, max) };
  });
}

/** §10.3-B's closure block, over the Zones in the report. */
function closureOf(zones: readonly ReportZone[]): ReportClosure {
  const items = zones.flatMap((zone) => zone.nonconformities);
  const closed = items.filter(
    (item) => item.status === 'VERIFIED' && item.outcome?.option === 'COMPLETED',
  ).length;
  const notPossible = items.filter(
    (item) => item.status === 'VERIFIED' && item.outcome?.option === 'NOT_POSSIBLE',
  ).length;
  const open = items.length - closed - notPossible;

  const durations = items
    .filter((item) => item.outcome?.verifiedAt)
    .map((item) => {
      const submitted = Date.parse(item.outcome!.submittedAt);
      const verified = Date.parse(item.outcome!.verifiedAt!);
      return (verified - submitted) / 3_600_000;
    })
    .filter((hours) => Number.isFinite(hours) && hours >= 0);

  return {
    nonconformities: items.length,
    closed,
    notPossible,
    open,
    closureRatePercentage: percentageOf(closed + notPossible, items.length),
    averageClosureHours:
      durations.length === 0
        ? null
        : Math.round((durations.reduce((sum, hours) => sum + hours, 0) / durations.length) * 100) /
          100,
  };
}

/** §10.3-C's added blocks: rankings, histogram and the nonconformity summary. */
function summaryExtrasOf(zones: readonly ReportZone[]): ReportSummaryExtras {
  const ranked = zones
    .filter((zone) => zone.scored && zone.totals.scorePercentage !== null)
    .map((zone) => ({
      zoneCode: zone.zoneCode,
      zoneName: zone.zoneName,
      pct: zone.totals.scorePercentage!,
      weakestSection: weakestSectionOf(zone),
    }))
    .sort((a, b) => b.pct - a.pct || a.zoneCode.localeCompare(b.zoneCode));

  const top = Math.min(5, ranked.length);
  const items = zones.flatMap((zone) => zone.nonconformities);

  // "Recurrent questions": the same check point failing in more than one selected Zone.
  // Counted by Zone rather than by photograph, so three photos of one shelf in one Zone do
  // not read as a pattern across the Unit.
  const byQuestion = new Map<number, { text: string | null; zones: Set<string> }>();
  for (const zone of zones) {
    for (const item of zone.nonconformities) {
      if (item.questionGlobalOrder === null) continue;
      const entry = byQuestion.get(item.questionGlobalOrder) ?? {
        text: item.questionText,
        zones: new Set<string>(),
      };
      entry.zones.add(zone.auditZoneId);
      byQuestion.set(item.questionGlobalOrder, entry);
    }
  }

  return {
    highest: ranked.slice(0, top).map(({ zoneCode, zoneName, pct }) => ({ zoneCode, zoneName, pct })),
    lowest: ranked.slice(-top).reverse(),
    histogram: RATING_BANDS.map((band) => ({
      token: band.token,
      label: band.label,
      count: ranked.filter((zone) => bandFor(zone.pct)?.token === band.token).length,
    })),
    nonconformitySummary: {
      open: items.filter((item) => item.status === 'OPEN' || item.status === 'REOPENED').length,
      submitted: items.filter(
        (item) => item.status === 'ACTION_SUBMITTED' || item.status === 'NOT_POSSIBLE',
      ).length,
      verified: items.filter((item) => item.status === 'VERIFIED').length,
      recurrent: [...byQuestion.entries()]
        .filter(([, entry]) => entry.zones.size > 1)
        .sort((a, b) => b[1].zones.size - a[1].zones.size || a[0] - b[0])
        .slice(0, 10)
        .map(([order, entry]) => ({
          questionGlobalOrder: order,
          questionText: entry.text,
          zones: entry.zones.size,
        })),
    },
  };
}

/** The S a Zone is weakest in — §10.3-C's "dominant weak S". Null when none is applicable. */
function weakestSectionOf(zone: ReportZone): SSection | null {
  let weakest: { section: SSection; pct: number } | null = null;
  for (const section of zone.sections) {
    if (section.pct === null) continue;
    if (!weakest || section.pct < weakest.pct) {
      weakest = { section: section.section, pct: section.pct };
    }
  }
  return weakest?.section ?? null;
}

function joinAddress(unit: { address: string | null; city: string | null; state: string | null }) {
  const parts = [unit.address, unit.city, unit.state].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== '',
  );
  return parts.length > 0 ? parts.join(', ') : null;
}
