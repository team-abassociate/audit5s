import {
  KAIZEN_REQUIRED_FIELDS,
  type KaizenAnalysisRow,
  type KaizenDashboard,
  type KaizenDashboardPeriod,
  type KaizenDepartmentSeries,
  type KaizenFields,
  type KaizenFunnel,
  type KaizenKpi,
  type KaizenMissingItem,
  type KaizenRequiredField,
  type KaizenStatus,
  type KaizenTrendMonth,
} from '@audit5s/contracts';
import { istDateKey } from './datetime';

/**
 * Kaizen's pure rules (R-48, plans/kaizen-module.md §4.2 and §4.7): what makes a sheet
 * submittable, and how every number on the dashboard is counted.
 *
 * The API alone calls the counting functions; the clients render what it sends and compute
 * nothing, so a phone and the web can never show two different acceptance ratios. The state
 * machine itself is `KAIZEN_TRANSITIONS` in `state-machine.ts`, beside the others.
 *
 * Three rules hold everywhere below:
 *
 *   - **A DRAFT is never counted.** It hasn't been submitted.
 *   - **A Kaizen belongs to the period it was first submitted in.** A resubmission after
 *     SENT_BACK does not move it, so a month's "Submitted" never grows retroactively.
 *   - **Dates are India Standard Time** (`istDateKey`), as every screen prints them: a
 *     Kaizen submitted at 1 AM IST on 1 Nov is November's, whatever the server's clock says.
 */

// ---------------------------------------------------------------- submittability

/**
 * The required steps still empty, in form order. Empty ⇒ the `kaizen_sheet_complete` guard
 * holds. A blank or whitespace string is empty; `horizontalDeployment: false` is an answer.
 */
export function missingKaizenFields(
  sheet: Partial<Record<keyof KaizenFields, unknown>>,
): KaizenRequiredField[] {
  return KAIZEN_REQUIRED_FIELDS.filter((field) => {
    const value = sheet[field];
    return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  });
}

/**
 * `missingKaizenFields`, then the before and after photos (owner, 2026-10-10, R-49): what
 * stops a submit, in form order. The phone and the server call this one, so they cannot
 * disagree. `missingKaizenFields` stays as it is: 0044's CHECK mirrors it, and photos are
 * not columns.
 */
export function missingKaizenItems(
  sheet: Partial<Record<keyof KaizenFields, unknown>>,
  photos: { before: boolean; after: boolean },
): KaizenMissingItem[] {
  return [
    ...missingKaizenFields(sheet),
    ...(photos.before ? [] : ['beforePhoto' as const]),
    ...(photos.after ? [] : ['afterPhoto' as const]),
  ];
}

// ------------------------------------------------------------------- the facts

/**
 * One Kaizen as the counting rules see it. The API reads these with one query per
 * dashboard; everything the visuals need is derivable from them.
 */
export interface KaizenFact {
  status: KaizenStatus;
  /** First submission. Null for a DRAFT that never left the phone's hands. */
  submittedAt: string | null;
  /** When it was approved (the APPROVED review's time), or null. */
  approvedAt: string | null;
  /** At least one review decision, now or before — the funnel's "Reviewed". */
  reviewed: boolean;
  annualSaving: number | null;
  /** The Zone's `department_hint`, raw. */
  department: string | null;
  zoneId: string;
  zoneName: string;
  zoneCode: string;
}

/** Submitted at least once: any status but DRAFT, with a first-submission time. */
function counted(fact: KaizenFact): fact is KaizenFact & { submittedAt: string } {
  return fact.status !== 'DRAFT' && fact.submittedAt !== null;
}

function monthKey(iso: string): string {
  return istDateKey(iso)!.slice(0, 7);
}

/** Whether an instant falls in the period that contains `now`, in IST. */
export function inKaizenPeriod(iso: string, period: KaizenDashboardPeriod, now: Date): boolean {
  if (period === 'overall') return true;
  const length = period === 'year' ? 4 : 7;
  return monthKey(iso).slice(0, length) === monthKey(now.toISOString()).slice(0, length);
}

/** Counted, and first submitted in the period. */
function periodFacts(facts: readonly KaizenFact[], period: KaizenDashboardPeriod, now: Date) {
  return facts.filter((fact) => counted(fact) && inKaizenPeriod(fact.submittedAt, period, now));
}

/** `part ÷ whole × 100`, exact. Null when the whole is 0: the clients show "—", never "0 %". */
export function kaizenRatioPct(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

/**
 * `₹1,08,000`: whole rupees, grouped the Indian way (lakh, crore). Written out rather than
 * `Intl` because Hermes on Android does not reliably group `en-IN`, and the phone, the web
 * and the PDF must print the same figure. Null is "—", never ₹0.
 */
export function formatRupees(value: number | null): string {
  if (value === null) return '—';
  const digits = String(Math.round(Math.abs(value)));
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ',');
  return `${value < 0 ? '-' : ''}₹${head ? `${head},` : ''}${digits.slice(-3)}`;
}

/** Rupee sums in paise, so ten thousand savings add up to the rupee they should. */
function sumRupees(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + Math.round((value ?? 0) * 100), 0) / 100;
}

// ------------------------------------------------------------------ A. KPI card

export function kaizenKpi(
  facts: readonly KaizenFact[],
  period: KaizenDashboardPeriod,
  now: Date,
): KaizenKpi {
  const inPeriod = periodFacts(facts, period, now);
  const count = (status: KaizenStatus) => inPeriod.filter((fact) => fact.status === status).length;
  const submitted = inPeriod.length;
  const rejected = count('REJECTED');
  const approved = count('APPROVED');
  return {
    submitted,
    awaitingReview: count('SUBMITTED'),
    sentBack: count('SENT_BACK'),
    rejected,
    approved,
    rejectionRatioPct: kaizenRatioPct(rejected, submitted),
    acceptanceRatioPct: kaizenRatioPct(approved, submitted),
  };
}

// --------------------------------------------------------------------- B. funnel

/** Each stage a subset of the one before, so the funnel always narrows. */
export function kaizenFunnel(
  facts: readonly KaizenFact[],
  period: KaizenDashboardPeriod,
  now: Date,
): KaizenFunnel {
  const submitted = periodFacts(facts, period, now);
  const reviewed = submitted.filter((fact) => fact.reviewed || fact.status !== 'SUBMITTED');
  const approved = reviewed.filter((fact) => fact.status === 'APPROVED');
  const withSaving = approved.filter((fact) => (fact.annualSaving ?? 0) > 0);
  const stage = (name: KaizenFunnel[number]['stage'], items: readonly KaizenFact[]) => ({
    stage: name,
    count: items.length,
    pctOfSubmitted: kaizenRatioPct(items.length, submitted.length),
  });
  return [
    stage('SUBMITTED', submitted),
    stage('REVIEWED', reviewed),
    stage('APPROVED', approved),
    stage('APPROVED_WITH_SAVING', withSaving),
  ];
}

// ---------------------------------------------------------------------- C. trend

/** The last six calendar months in IST, oldest first, the current one last. */
export function lastSixMonths(now: Date): string[] {
  const [year, month] = monthKey(now.toISOString()).split('-').map(Number) as [number, number];
  return Array.from({ length: 6 }, (_, index) => {
    const offset = month - 1 - (5 - index);
    const y = year + Math.floor(offset / 12);
    const m = ((offset % 12) + 12) % 12;
    return `${y}-${String(m + 1).padStart(2, '0')}`;
  });
}

/** Submitted (by first submission) and approved (by approval date) per month. Never a gap. */
export function kaizenTrend(facts: readonly KaizenFact[], now: Date): KaizenTrendMonth[] {
  const months = lastSixMonths(now);
  const submitted = new Map(months.map((month) => [month, 0]));
  const approved = new Map(months.map((month) => [month, 0]));
  for (const fact of facts) {
    if (!counted(fact)) continue;
    bump(submitted, monthKey(fact.submittedAt));
    if (fact.status === 'APPROVED' && fact.approvedAt) bump(approved, monthKey(fact.approvedAt));
  }
  return months.map((month) => ({
    month,
    submitted: submitted.get(month)!,
    approved: approved.get(month)!,
  }));
}

function bump(counts: Map<string, number>, key: string): void {
  const current = counts.get(key);
  if (current !== undefined) counts.set(key, current + 1);
}

// --------------------------------------------------------------- D. departments

/**
 * The group a Zone's free-text department falls in: trimmed, inner spaces collapsed,
 * case-folded. `''` is "No department". "Assembly " and "assembly" are one department.
 */
export function departmentKey(hint: string | null): string {
  return (hint ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Each department's label: its most common spelling (trimmed), ties to the
 * alphabetically first so the label never flickers between loads. Null for `''`.
 */
function departmentLabels(facts: readonly KaizenFact[]): Map<string, string | null> {
  const spellings = new Map<string, Map<string, number>>();
  for (const fact of facts) {
    const key = departmentKey(fact.department);
    if (key === '') continue;
    const spelling = fact.department!.trim().replace(/\s+/g, ' ');
    const counts = spellings.get(key) ?? new Map<string, number>();
    counts.set(spelling, (counts.get(spelling) ?? 0) + 1);
    spellings.set(key, counts);
  }
  const labels = new Map<string, string | null>([['', null]]);
  for (const [key, counts] of spellings) {
    const [best] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    labels.set(key, best![0]);
  }
  return labels;
}

/**
 * "Top 5 trend – Departments": the five departments with the most Kaizens over the same six
 * months as the trend, under each toggle. Ties go to the alphabetically first label, with
 * "No department" last among equals. Fewer than five → what there is; none → empty.
 */
export function kaizenTopDepartments(
  facts: readonly KaizenFact[],
  now: Date,
): { submitted: KaizenDepartmentSeries[]; approved: KaizenDepartmentSeries[] } {
  const months = lastSixMonths(now);
  const labels = departmentLabels(facts);
  const countedFacts = facts.filter(counted);

  const series = (when: (fact: KaizenFact) => string | null): KaizenDepartmentSeries[] => {
    const byDepartment = new Map<string, number[]>();
    for (const fact of countedFacts) {
      const at = when(fact);
      const index = at ? months.indexOf(monthKey(at)) : -1;
      if (index < 0) continue;
      const key = departmentKey(fact.department);
      const monthly = byDepartment.get(key) ?? [0, 0, 0, 0, 0, 0];
      monthly[index]! += 1;
      byDepartment.set(key, monthly);
    }
    return [...byDepartment]
      .map(([key, monthly]) => ({
        key,
        label: labels.get(key) ?? null,
        monthly,
        total: monthly.reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.total - a.total || compareLabels(a.label, b.label))
      .slice(0, 5);
  };

  return {
    submitted: series((fact) => fact.submittedAt),
    approved: series((fact) => (fact.status === 'APPROVED' ? fact.approvedAt : null)),
  };
}

/** Alphabetical, with "No department" (null) after every named one. */
function compareLabels(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

// ---------------------------------------------------------------- the dashboard

/** `GET /kaizens/dashboard`: every number on the four visuals, from one set of facts. */
export function kaizenDashboard(
  facts: readonly KaizenFact[],
  period: KaizenDashboardPeriod,
  now: Date,
): KaizenDashboard {
  return {
    period,
    serverTime: now.toISOString(),
    kpi: kaizenKpi(facts, period, now),
    funnel: kaizenFunnel(facts, period, now),
    trend: kaizenTrend(facts, now),
    topDepartments: kaizenTopDepartments(facts, now),
  };
}

// ------------------------------------------------------------------- the table

/**
 * The department-wise or zone-wise table under the charts. "Returned" is sent back plus
 * rejected: returned to the author either way. Largest total first, then by label.
 */
export function kaizenAnalysis(
  facts: readonly KaizenFact[],
  by: 'department' | 'zone',
  period: KaizenDashboardPeriod,
  now: Date,
): KaizenAnalysisRow[] {
  const labels = departmentLabels(facts);
  const rows = new Map<string, { row: KaizenAnalysisRow; savings: (number | null)[] }>();

  for (const fact of periodFacts(facts, period, now)) {
    const key = by === 'zone' ? fact.zoneId : departmentKey(fact.department);
    const entry = rows.get(key) ?? {
      row: {
        key,
        label: by === 'zone' ? fact.zoneName : (labels.get(key) ?? null),
        zoneCode: by === 'zone' ? fact.zoneCode : null,
        total: 0,
        approved: 0,
        pending: 0,
        returned: 0,
        approvedSaving: 0,
      },
      savings: [],
    };
    entry.row.total += 1;
    if (fact.status === 'APPROVED') {
      entry.row.approved += 1;
      entry.savings.push(fact.annualSaving);
    }
    if (fact.status === 'SUBMITTED') entry.row.pending += 1;
    if (fact.status === 'SENT_BACK' || fact.status === 'REJECTED') entry.row.returned += 1;
    rows.set(key, entry);
  }

  return [...rows.values()]
    .map(({ row, savings }) => ({ ...row, approvedSaving: sumRupees(savings) }))
    .sort((a, b) => b.total - a.total || compareLabels(a.label, b.label));
}

// ------------------------------------------------------------------- Top 3

/**
 * "Top 3 approved by saving" on the Coordinator's Overview: approved only, largest saving
 * first, newest first among equals. Generic so the API can hand it whole records.
 */
export function topApprovedBySaving<
  T extends { status: KaizenStatus; annualSaving: number | null; submittedAt: string | null },
>(kaizens: readonly T[], count = 3): T[] {
  return kaizens
    .filter((kaizen) => kaizen.status === 'APPROVED')
    .sort(
      (a, b) =>
        (b.annualSaving ?? 0) - (a.annualSaving ?? 0) ||
        (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''),
    )
    .slice(0, count);
}
