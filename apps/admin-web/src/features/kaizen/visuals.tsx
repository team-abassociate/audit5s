import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type {
  KaizenDashboardPeriod,
  KaizenDepartmentSeries,
  KaizenFunnel,
  KaizenKpi,
  KaizenTrendMonth,
} from '@audit5s/contracts';
import { formatKaizenRatio, formatYearMonth, textOn } from '@audit5s/domain';
import { Card, CardHeader, EmptyState, Segmented } from '@/components/ui';
import { useToken } from '@/lib/tokens';

/**
 * Kaizen's four dashboard visuals on the web (plans/kaizen-module.md §4.7), from what
 * `GET /kaizens/dashboard` sends: nothing is counted here. Colours are tokens read at
 * runtime (`useToken`), so a chart repaints with the theme. Green is Approved, nothing else.
 */

const TOOLTIP = {
  background: 'var(--tile)',
  border: '1.5px solid var(--edge)',
  borderRadius: 0,
  color: 'var(--ink)',
  fontSize: 12.5,
} as const;

const PERIODS = [
  { value: 'overall', label: 'Overall' },
  { value: 'year', label: 'Year' },
  { value: 'month', label: 'Month' },
] as const;

export function PeriodControl({ value, onChange }: { value: KaizenDashboardPeriod; onChange: (period: KaizenDashboardPeriod) => void }) {
  return <Segmented label="Period" options={PERIODS} value={value} onChange={onChange} />;
}

// ------------------------------------------------------------------------- A. KPI card

export function KpiCard({ kpi, period, onPeriod }: { kpi: KaizenKpi; period: KaizenDashboardPeriod; onPeriod: (p: KaizenDashboardPeriod) => void }) {
  const cells: [string, string][] = [
    ['Submitted', String(kpi.submitted)],
    ['Awaiting review', String(kpi.awaitingReview)],
    ['Sent back', String(kpi.sentBack)],
    ['Rejected', String(kpi.rejected)],
    ['Rejection ratio', formatKaizenRatio(kpi.rejectionRatioPct)],
    ['Acceptance ratio', formatKaizenRatio(kpi.acceptanceRatioPct)],
  ];
  return (
    <Card>
      <CardHeader title="Kaizen at a glance" action={<PeriodControl value={period} onChange={onPeriod} />} />
      <div className="gb-kz-kpi">
        {cells.map(([label, value]) => (
          <div key={label}>
            <b className="gb-figure">{value}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------------- B. funnel

const STAGE_NAME = {
  SUBMITTED: 'Submitted',
  REVIEWED: 'Reviewed',
  APPROVED: 'Approved',
  APPROVED_WITH_SAVING: 'Approved with a saving',
} as const;
/** A stage never narrower than this share, so a zero stage still shows its count. */
const MIN_STAGE = 0.2;

/**
 * Trapezoids whose top edge is the stage's own width and bottom edge the next stage's — the
 * reference shape — drawn with `clip-path`, so a period change eases every edge (`--motion`,
 * ease-out; none under reduced motion). Only the count sits on the fill: light `--ok-band`
 * holds no small text at 4.5:1 in either ink or tile, so the name and share stand beside it.
 */
export function FunnelCard({ funnel, period, onPeriod }: { funnel: KaizenFunnel; period: KaizenDashboardPeriod; onPeriod: (p: KaizenDashboardPeriod) => void }) {
  const token = useToken();
  const first = funnel[0]?.count ?? 0;
  const widths = funnel.map((stage) => (first > 0 ? Math.max(stage.count / first, MIN_STAGE) : MIN_STAGE) * 100);
  const fills = ['--edge-soft', '--ink-3', '--ok-band', '--ok'];
  return (
    <Card>
      <CardHeader title="Kaizen funnel" action={<PeriodControl value={period} onChange={onPeriod} />} />
      <ol className="gb-kz-funnel">
        {funnel.map((stage, index) => {
          const top = widths[index]!;
          const bottom = widths[index + 1] ?? top;
          const fill = token(fills[index] ?? '--edge-soft');
          const ink = fill ? textOn(fill, token('--ink'), token('--tile')) : 'var(--ink)';
          const clip = `polygon(${(100 - top) / 2}% 0, ${(100 + top) / 2}% 0, ${(100 + bottom) / 2}% 100%, ${(100 - bottom) / 2}% 100%)`;
          return (
            <li key={stage.stage} className="gb-kz-stage">
              <div className="gb-kz-trap" style={{ clipPath: clip, background: `var(${fills[index]})` }} aria-hidden="true">
                <span className="gb-figure" style={{ color: ink }}>
                  {stage.count}
                </span>
              </div>
              <div className="gb-kz-stage-name">
                <span className="sr-only">{stage.count} </span>
                {STAGE_NAME[stage.stage]}
                <small>{formatKaizenRatio(stage.pctOfSubmitted)} of submitted</small>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

// ---------------------------------------------------------------------------- C. trend

export function TrendCard({ trend }: { trend: readonly KaizenTrendMonth[] }) {
  const token = useToken();
  const data = trend.map((month) => ({ month: formatYearMonth(month.month), submitted: month.submitted, approved: month.approved }));
  return (
    <Card>
      <div className="gb-panel-head">
        {/* The two title words are the legend, styled like their bars (§4.7 C). */}
        <h2 className="gb-h2 gb-kz-trend-title">
          Kaizen <b style={{ color: 'var(--ink-3)' }}>submission</b> / <b style={{ color: 'var(--ok)' }}>completion</b> trend
        </h2>
      </div>
      <figure className="m-0 p-3" aria-label={`Last six months: ${trend.map((m) => `${formatYearMonth(m.month)} ${m.submitted} submitted, ${m.approved} approved`).join('; ')}.`}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} accessibilityLayer={false} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={token('--edge-soft')} />
            <XAxis dataKey="month" stroke={token('--ink-3')} tick={{ fontFamily: 'var(--font-data)', fontSize: 11 }} />
            <YAxis allowDecimals={false} domain={[0, 'auto']} stroke={token('--ink-3')} tick={{ fontFamily: 'var(--font-data)', fontSize: 11 }} />
            <Tooltip contentStyle={TOOLTIP} cursor={{ fill: token('--tile-2') }} />
            <Bar isAnimationActive={false} dataKey="submitted" name="Submitted" fill={token('--edge-soft')} stroke={token('--ink-3')} strokeWidth={1} />
            <Bar isAnimationActive={false} dataKey="approved" name="Approved" fill={token('--ok-band')} />
          </BarChart>
        </ResponsiveContainer>
      </figure>
    </Card>
  );
}

// -------------------------------------------------------------------- D. top departments

/**
 * Five departments told apart without colour (§4.7 D): an ink-scale fill **and** a pattern
 * on alternate series — solid, hatched, outlined — so it reads in sunlight and greyscale.
 */
const SERIES = ['--ink', '--ink-2', '--ink-3', '--edge-soft', '--tape'] as const;
type Look = { fill: string; stroke?: string };

export function TopDepartmentsCard({
  months,
  series,
}: {
  months: readonly string[];
  series: { submitted: readonly KaizenDepartmentSeries[]; approved: readonly KaizenDepartmentSeries[] };
}) {
  const token = useToken();
  const [which, setWhich] = useState<'submitted' | 'approved'>('submitted');
  const lines = series[which];
  const name = (line: KaizenDepartmentSeries) => line.label ?? 'No department';
  const look = (index: number): Look => {
    const colour = token(SERIES[index] ?? '--ink-3');
    if (index % 3 === 1) return { fill: `url(#kz-hatch-${index})`, stroke: colour };
    if (index % 3 === 2) return { fill: token('--tile'), stroke: colour };
    return { fill: colour };
  };
  const data = months.map((month, monthIndex) => ({
    month: formatYearMonth(month),
    ...Object.fromEntries(lines.map((line) => [line.key || 'none', line.monthly[monthIndex] ?? 0])),
  }));

  return (
    <Card>
      <CardHeader
        title="Top 5 trend – Departments"
        action={
          <Segmented
            label="Count"
            options={[
              { value: 'submitted', label: 'Submitted' },
              { value: 'approved', label: 'Approved' },
            ]}
            value={which}
            onChange={setWhich}
          />
        }
      />
      {lines.length === 0 ? (
        <EmptyState title="No Kaizens in the last six months." />
      ) : (
        <div className="p-3">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data} accessibilityLayer={false} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
              <defs>
                {lines.map((_, index) =>
                  index % 3 === 1 ? (
                    <pattern key={index} id={`kz-hatch-${index}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <rect width="6" height="6" fill={token('--tile')} />
                      <rect width="3" height="6" fill={token(SERIES[index] ?? '--ink-3')} />
                    </pattern>
                  ) : null,
                )}
              </defs>
              <CartesianGrid vertical={false} stroke={token('--edge-soft')} />
              <XAxis dataKey="month" stroke={token('--ink-3')} tick={{ fontFamily: 'var(--font-data)', fontSize: 11 }} />
              <YAxis allowDecimals={false} stroke={token('--ink-3')} tick={{ fontFamily: 'var(--font-data)', fontSize: 11 }} />
              <Tooltip contentStyle={TOOLTIP} cursor={{ fill: token('--tile-2') }} />
              {lines.map((line, index) => (
                <Bar
                  key={line.key || 'none'}
                  isAnimationActive={false}
                  dataKey={line.key || 'none'}
                  name={name(line)}
                  fill={look(index).fill}
                  stroke={look(index).stroke ?? 'none'}
                  strokeWidth={1.5}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <ul className="gb-kz-legend mt-3">
            {lines.map((line, index) => (
              <li key={line.key || 'none'}>
                <span>
                  <svg viewBox="0 0 14 14" aria-hidden="true">
                    <rect x="0.75" y="0.75" width="12.5" height="12.5" fill={look(index).fill} stroke={look(index).stroke ?? 'none'} strokeWidth="1.5" />
                  </svg>
                  {name(line)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
