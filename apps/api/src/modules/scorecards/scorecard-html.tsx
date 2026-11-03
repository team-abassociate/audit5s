import { renderToStaticMarkup } from 'react-dom/server';
import type { Audit, AuditScoreSummary } from '@audit5s/contracts';
import { BRAND_TOKENS, RATING_BANDS, RESPONSE_TOKENS, zoneDisplayLabel } from '@audit5s/domain';
import { sanitizeFileName } from '../reports/report-file-name';
import {
  Footer,
  Header,
  MetaCell,
  RadarWeb,
  RatingPills,
  SectionTable,
  bandOf,
  formatDate,
  formatMarks,
  formatPercentage,
} from '../reports/templates/components';
import { reportStyles } from '../reports/templates/styles';

/**
 * R-80: the score card the auditor sees at the end of an audit, as a PDF with the Unit and
 * the Zone named on it. Drawn from the Zone report's own parts so it reads as one family.
 */
export type ScorecardAudit = Pick<Audit, 'unitName' | 'auditorName' | 'auditType' | 'completedAt' | 'startedAt'>;

const AUDIT_TYPE_LABELS: Record<Audit['auditType'], string> = {
  EXTERNAL_5S: 'External audit',
  CROSS_5S: 'Cross audit',
  WALK_BY: 'Walk-by',
};

const bands = RATING_BANDS.map((band) => ({ ...band }));
const brand: Record<string, string> = { ...BRAND_TOKENS };

function zoneLabels(summary: AuditScoreSummary): string {
  return summary.zones.map((zone) => zoneDisplayLabel(zone.zoneCode, zone.zoneName)).join(', ');
}

/** `Score card - {Unit} - Zone {n} {name} - {date}.pdf`, like the Kaizen Sheet's. */
export function scorecardFileName(audit: ScorecardAudit, summary: AuditScoreSummary): string {
  const zones = zoneLabels(summary).replace(/ — /g, ' ');
  const date = formatDate(audit.completedAt ?? audit.startedAt);
  return `${sanitizeFileName(['Score card', audit.unitName, zones, date].join(' - '), 'score-card')}.pdf`;
}

export function renderScorecardHtml(audit: ScorecardAudit, summary: AuditScoreSummary): string {
  const whole = summary.zones.length > 1 ? [{ ...summary.audit, label: 'Whole audit' }] : [];
  const blocks = [
    ...summary.zones.map((zone) => ({ ...zone, label: zoneDisplayLabel(zone.zoneCode, zone.zoneName) })),
    ...whole,
  ];
  const body = renderToStaticMarkup(
    <div className="page">
      <Header title="5S Score Card" subtitle={`${audit.unitName} — ${zoneLabels(summary)}`} />
      <div className="meta-grid">
        <MetaCell label="Unit" value={audit.unitName} />
        <MetaCell label="Zone" value={zoneLabels(summary)} />
        <MetaCell label="Audit" value={AUDIT_TYPE_LABELS[audit.auditType]} />
        <MetaCell label="Date" value={formatDate(audit.completedAt ?? audit.startedAt)} />
        <MetaCell label="Auditor" value={audit.auditorName} />
        {summary.zones[0]?.auditeeName ? <MetaCell label="Auditee" value={summary.zones[0].auditeeName} /> : null}
      </div>
      {blocks.map((block) => {
        const band = bandOf(bands, block.totals.scorePercentage);
        return (
          <div key={block.label}>
            <h2 className="section-title">{block.label}</h2>
            <div className="meta-grid">
              <MetaCell label="Marks" value={formatMarks(block.totals.rawScore, block.totals.maxScore)} />
              <MetaCell label="Score" value={formatPercentage(block.totals.scorePercentage)} />
              <MetaCell label="Rating" value={band?.label ?? 'N/A'} />
            </div>
            <SectionTable sections={block.sections} bands={bands} />
            <RadarWeb sections={block.sections} bands={bands} brand={brand} />
          </div>
        );
      })}
      <RatingPills bands={bands} />
      <p className="caption">
        NA answers are excluded from the applicable maximum. This score card is not the official report.
      </p>
      <Footer />
    </div>,
  );
  const styles = reportStyles({
    brand: { ...BRAND_TOKENS },
    bands,
    responseTokens: Object.fromEntries(Object.entries(RESPONSE_TOKENS).map(([key, token]) => [key, { ...token }])),
  });
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>5S Score Card</title>`,
    `<style>${styles}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}
