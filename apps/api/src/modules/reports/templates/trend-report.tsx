import { S_SECTION_ORDER, S_SECTION_SHORT_LABELS } from '@audit5s/domain';
import type { ReportPayload, ReportTrend } from './payload-types';
import {
  Footer,
  Header,
  MetaCell,
  RadarWeb,
  RatingPills,
  TrendBars,
  bandOf,
  formatDate,
  formatMarks,
  formatPercentage,
  ratingLabel,
} from './components';

/**
 * R-75: the summary of summaries — the overall score, each S and the 5S web of every chosen
 * audit of a Zone, or of every chosen Summary report of a Unit, side by side.
 *
 * Scores only: no checklist, no photograph, no link. Management reads it to see the
 * direction of travel, and every figure is already in the summaries it compares. There is
 * no limit on how many points it shows, so every block flows onto as many pages as it needs
 * rather than shrinking past legibility.
 */
export function TrendReport({ payload }: { payload: ReportPayload }) {
  const trend = payload.trend;
  if (!trend) {
    return (
      <>
        <Header title="LEAN 5S — SUMMARY OF SUMMARIES" subtitle="Trend" />
        <p>This report has nothing to compare.</p>
      </>
    );
  }

  const zoneWise = trend.scope === 'ZONE';
  const label = (point: ReportTrend['points'][number]) => spanLabel(point.from, point.to);

  return (
    <>
      <Footer />
      <Header
        title="LEAN 5S — SUMMARY OF SUMMARIES"
        subtitle={zoneWise ? `Zone-wise trend · ${trend.zoneLabel ?? ''}` : 'Unit-wise trend'}
      />

      <div className="meta-grid">
        <MetaCell label="Company / Unit" value={payload.unit.name} />
        <MetaCell label={zoneWise ? 'Zone' : 'Scope'} value={zoneWise ? (trend.zoneLabel ?? '—') : 'Whole Unit'} />
        <MetaCell
          label="Period"
          value={payload.auditDateRange ? spanLabel(payload.auditDateRange.from, payload.auditDateRange.to) : '—'}
        />
        <MetaCell
          label={zoneWise ? 'Audits compared' : 'Summary reports compared'}
          value={String(trend.points.length)}
        />
        <MetaCell
          label="Overall percentage"
          value={formatPercentage(payload.totals.scorePercentage)}
        />
        <MetaCell label="Overall rating" value={ratingLabel(payload, payload.totals.scorePercentage)} />
      </div>

      <h2 className="section-title">Overall score trend</h2>
      <TrendBars
        points={trend.points.map((point) => ({ label: label(point), pct: point.totals.scorePercentage }))}
        bands={payload.bands}
        brand={payload.brand}
        width={680}
        height={220}
      />
      <RatingPills bands={payload.bands} />

      <h2 className="section-title">S-wise trend</h2>
      <div className="s-trend-grid">
        {S_SECTION_ORDER.map((section) => (
          <div className="avoid-break" key={section}>
            <div className="photo-caption">{S_SECTION_SHORT_LABELS[section]}</div>
            <TrendBars
              points={trend.points.map((point) => ({
                label: label(point),
                pct: point.sections.find((entry) => entry.section === section)?.pct ?? null,
              }))}
              bands={payload.bands}
              brand={payload.brand}
              width={330}
              height={120}
            />
          </div>
        ))}
      </div>

      <h2 className="section-title">Scores by {zoneWise ? 'audit' : 'summary report'}</h2>
      <table>
        <thead>
          <tr>
            <th>{zoneWise ? 'Audit date' : 'Period'}</th>
            {zoneWise ? null : <th className="centre">Zones</th>}
            {S_SECTION_ORDER.map((section) => (
              <th key={section} className="centre">
                {S_SECTION_SHORT_LABELS[section]}
              </th>
            ))}
            <th className="centre">Marks</th>
            <th className="centre">%</th>
          </tr>
        </thead>
        <tbody>
          {trend.points.map((point) => (
            <tr key={point.id}>
              <td>{label(point)}</td>
              {zoneWise ? null : <td className="centre">{point.zoneCount}</td>}
              {S_SECTION_ORDER.map((section) => {
                const score = point.sections.find((entry) => entry.section === section);
                const band = bandOf(payload.bands, score?.pct ?? null);
                return (
                  <td key={section} className={`centre ${band ? `tint-${band.token}` : 'na'}`}>
                    {formatPercentage(score?.pct ?? null)}
                  </td>
                );
              })}
              <td className="centre">{formatMarks(point.totals.rawScore, point.totals.maxScore)}</td>
              <td className={`centre ${tint(payload, point.totals.scorePercentage)}`}>
                {formatPercentage(point.totals.scorePercentage)}
              </td>
            </tr>
          ))}
          <tr className="total-row">
            <td colSpan={zoneWise ? 1 : 2}>Overall</td>
            {payload.sections.map((section) => (
              <td key={section.section} className="centre">
                {formatPercentage(section.pct)}
              </td>
            ))}
            <td className="centre">{formatMarks(payload.totals.rawScore, payload.totals.maxScore)}</td>
            <td className="centre">{formatPercentage(payload.totals.scorePercentage)}</td>
          </tr>
        </tbody>
      </table>

      <h2 className="section-title">5S performance webs</h2>
      <div className="web-grid">
        <div className="web-cell">
          <RadarWeb sections={payload.sections} bands={payload.bands} brand={payload.brand} size={190} />
          <div className="photo-caption">Overall · {formatPercentage(payload.totals.scorePercentage)}</div>
        </div>
        {trend.points.map((point) => (
          <div className="web-cell" key={`web-${point.id}`}>
            <RadarWeb sections={point.sections} bands={payload.bands} brand={payload.brand} size={190} />
            <div className="photo-caption">
              {label(point)} · {formatPercentage(point.totals.scorePercentage)}
            </div>
          </div>
        ))}
      </div>

      <div className="footnote">
        Overall figures are summed achieved marks over summed applicable maximum across every
        compared {zoneWise ? 'audit' : 'summary report'}, never an average of percentages. NA
        answers are excluded from the applicable maximum.
      </div>
    </>
  );
}

function spanLabel(from: string | null, to: string | null): string {
  const start = formatDate(from ?? to);
  const end = formatDate(to ?? from);
  return start === end ? start : `${start} – ${end}`;
}

function tint(payload: ReportPayload, pct: number | null): string {
  const band = bandOf(payload.bands, pct);
  return band ? `tint-${band.token}` : 'na';
}
