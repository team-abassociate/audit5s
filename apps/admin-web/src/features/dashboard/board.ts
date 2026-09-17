import type { SectionScorePayload, SSection, Zone, ZoneRankingItem } from '@audit5s/contracts';
import { bandOf, type Band } from '@/lib/bands';

export { bandLabel, bandOf, type Band } from '@/lib/bands';

/**
 * The board's pure part: everything that turns server payloads into the shapes
 * `DashboardPage` renders. Kept out of the component so it can be checked without a DOM
 * (board.test.ts), and so that nothing here can be tempted to compute a score — the
 * server owns those (GEMBA-BOARD.md §3, ARCHITECTURE.md §8.6).
 */

/** One decimal in tiles and charts (§3). `null` is `N/A`, never `0`. */
export function score1(percentage: number | null): string {
  return percentage === null ? 'N/A' : percentage.toFixed(1);
}

/**
 * Two decimals for an audit score in a register or table.
 *
 * §3 originally called for three here, on the reasoning that those tables stand in for the
 * record. The owner asked for two: the third decimal of a percentage is noise a plant
 * manager reads past, and no band boundary falls between two and three decimals, so nothing
 * can change band by rounding here. `score3` is kept for the places that genuinely are a
 * ledger.
 */
export function score2(percentage: number | null): string {
  return percentage === null ? 'N/A' : percentage.toFixed(2);
}

/** Three decimals in anything that stands in for a record (§3). */
export function score3(percentage: number | null): string {
  return percentage === null ? 'N/A' : percentage.toFixed(3);
}

/** Always signed, with a real minus sign (U+2212). `null` has no delta to show. */
export function delta1(value: number | null): string {
  if (value === null) return '—';
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1)}`;
}

export interface BoardZone {
  zoneId: string;
  code: string;
  name: string;
  leader: string | null;
  /** The server's weighted score for the selected period. `null` = not audited in it. */
  score: number | null;
  /** Improvement on the previous audit, from the server. */
  delta: number | null;
  openNonconformities: number;
  lastAuditAt: string | null;
  daysSinceLastAudit: number | null;
  weakSection: SSection | null;
  /** The five sections of this Zone's latest completed audit; `null` when it has none. */
  sections: SectionScorePayload[] | null;
  auditorName: string | null;
  band: Band;
  /**
   * True when the server's analytics carry a row for this Zone. The rollup is a nightly
   * job, so a Zone can hold a completed audit and still be absent from it — which is a
   * different statement from "never audited", and the board must not conflate them.
   */
  ranked: boolean;
}

/** A completed audit the analytics rollup has not picked up yet. */
export function awaitingRollup(zone: BoardZone): boolean {
  return !zone.ranked && zone.sections !== null;
}

/** Keyed by Zone **code**: `GET /audits/{id}/summary` identifies its Zones by the snapshot. */
export interface LatestZoneAudit {
  sections: SectionScorePayload[];
  auditorName: string;
  completedAt: string | null;
}

/**
 * The board is every Zone in the Unit, not just the audited ones: a Zone with no audit in
 * the period is the dashed "not started" tile (§3), which is the one thing a cycle board
 * exists to make obvious. Audited Zones keep the server's worst-first order.
 */
export function mergeBoard(
  zones: Zone[],
  ranking: ZoneRankingItem[],
  latest: Map<string, LatestZoneAudit>,
): BoardZone[] {
  const byId = new Map(zones.map((zone) => [zone.id, zone]));
  const audited = ranking.map((item) => {
    const zone = byId.get(item.zoneId);
    const detail = latest.get(item.zoneCode);
    return {
      zoneId: item.zoneId,
      code: item.zoneCode,
      name: item.zoneName,
      leader: zone?.zoneLeaderName ?? null,
      score: item.score.scorePercentage,
      delta: item.improvement,
      openNonconformities: item.openNonconformities,
      lastAuditAt: item.lastAuditAt,
      daysSinceLastAudit: item.daysSinceLastAudit,
      weakSection: item.dominantWeakSection,
      sections: detail?.sections ?? null,
      auditorName: detail?.auditorName ?? null,
      band: bandOf(item.score.scorePercentage),
      ranked: true,
    } satisfies BoardZone;
  });
  const seen = new Set(ranking.map((item) => item.zoneId));
  const pending = zones
    .filter((zone) => !seen.has(zone.id) && zone.archivedAt === null)
    .map((zone) => {
      // A Zone absent from the ranking may still have been audited: the breakdown comes
      // from the audit itself, so it is shown rather than thrown away with the score.
      const detail = latest.get(zone.code);
      return {
        zoneId: zone.id,
        code: zone.code,
        name: zone.name,
        leader: zone.zoneLeaderName,
        score: null,
        delta: null,
        openNonconformities: 0,
        lastAuditAt: detail?.completedAt ?? null,
        daysSinceLastAudit: null,
        weakSection: null,
        sections: detail?.sections ?? null,
        auditorName: detail?.auditorName ?? null,
        band: 'none',
        ranked: false,
      } satisfies BoardZone;
    });
  return [...audited, ...pending];
}

/** The Zone the board should open on: the one that needs attention, not the first one. */
export function worstIndex(board: BoardZone[]): number {
  const index = board.findIndex((zone) => zone.score !== null);
  return index === -1 ? 0 : index;
}

export const SECTION_LABEL: Record<SSection, string> = {
  S1_SORT: 'S1 Sort',
  S2_SET_IN_ORDER: 'S2 Order',
  S3_SHINE: 'S3 Shine',
  S4_STANDARDIZE: 'S4 Std.',
  S5_SUSTAIN: 'S5 Sustain',
};

/**
 * The Outstanding boundary (R-6b, ≥ 90) is the target rule on the trend. GEMBA-BOARD.md §6
 * draws that rule at 85, a number this product's rating scale does not contain; the scale
 * wins on behaviour (R-1) and the design system on how the rule is drawn — dashed,
 * `--crit-band`, labelled.
 */
export const TARGET = 90;

const LEFT = 44;
const RIGHT = 706;
const TOP = 16;
const BOTTOM = 150;

/**
 * Breathing room inside the plot frame, so the first point does not sit on the y-axis and
 * the last does not touch the right edge. A marker drawn exactly on the axis reads as part
 * of the axis rather than as a reading.
 */
const INSET = 34;

/**
 * The widest gap allowed between two consecutive points.
 *
 * Without it the series always stretches to fill the frame, so three audits sat 330px
 * apart and the eye read the distance as elapsed time — which it is not, because the
 * x-axis here is one step per audit, not a calendar. Capping the step and centring what
 * is left keeps a short series legible and honest.
 */
const MAX_STEP = 96;

export interface TrendGeometry {
  line: string;
  area: string;
  /** One marker per reading. A line alone hides how many audits produced it. */
  points: Array<{ x: number; y: number; value: number; label: string }>;
  end: { x: number; y: number; value: number };
  yTicks: Array<{ y: number; label: string }>;
  xTicks: Array<{ x: number; label: string }>;
  targetY: number;
  gridY: number[];
}

/**
 * A hand-authored trend (§6): one scale, ticks labelled with values the chart actually
 * reaches, and room in the viewBox for the outermost labels. Periods with a `null` score
 * (nothing applicable) are left out rather than plotted as zero.
 */
export function trendGeometry(
  points: Array<{ period: string; scorePercentage: number | null }>,
): TrendGeometry | null {
  const scored = points.flatMap((point) =>
    point.scorePercentage === null ? [] : [{ period: point.period, value: point.scorePercentage }],
  );
  if (scored.length === 0) return null;

  const low = Math.max(0, Math.floor((Math.min(...scored.map((p) => p.value)) - 5) / 20) * 20);
  const span = 100 - low;

  // Points sit inside an inset frame, spaced at most `MAX_STEP` apart, and the run is
  // centred when it is narrower than the frame — so two audits read as two readings near
  // the middle rather than as a line flung across the page.
  const plotLeft = LEFT + INSET;
  const available = RIGHT - INSET - plotLeft;
  const step = scored.length === 1 ? 0 : Math.min(MAX_STEP, available / (scored.length - 1));
  const startX = plotLeft + (available - step * (scored.length - 1)) / 2;

  const x = (index: number) => startX + index * step;
  const y = (value: number) => TOP + ((100 - value) / span) * (BOTTOM - TOP);

  const coordinates = scored.map((point, index) => ({ x: x(index), y: y(point.value), ...point }));
  const line = coordinates.map((c) => `${round(c.x)},${round(c.y)}`).join(' L');
  const last = coordinates.at(-1)!;
  const ticks: number[] = [];
  for (let value = 100; value >= low; value -= 20) ticks.push(value);

  return {
    line: `M${line}`,
    area: `M${line} L${round(last.x)},${BOTTOM} L${round(coordinates[0]!.x)},${BOTTOM} Z`,
    points: coordinates.map((c) => ({
      x: round(c.x),
      y: round(c.y),
      value: c.value,
      label: c.period,
    })),
    end: { x: round(last.x), y: round(last.y), value: last.value },
    yTicks: ticks.map((value) => ({ y: round(y(value)), label: String(value) })),
    // Every other period when the series is long, so the axis never collides with itself.
    xTicks: coordinates
      .filter((_, index) => coordinates.length <= 7 || index % 2 === coordinates.length % 2)
      .map((c) => ({ x: round(c.x), label: c.period })),
    targetY: round(y(TARGET)),
    gridY: ticks.map((value) => round(y(value))),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
