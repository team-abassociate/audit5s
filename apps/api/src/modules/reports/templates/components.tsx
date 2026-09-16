import type {
  ReportBand,
  ReportPayload,
  ReportPhoto,
  SectionScorePayload,
} from './payload-types';
import { S_SECTION_SHORT_LABELS } from '@audit5s/domain';

/**
 * The pieces every report page is built from.
 *
 * Everything here is **static markup**. The radar and the comparison bars are inline SVG
 * computed on the server (HANDOFF.md §4's rendering constraint), not a chart library:
 * a client chart would need JavaScript to lay itself out, which is exactly what STACK.md
 * §5 forbids and what would make the WeasyPrint escape hatch a rewrite.
 */

/** Images are embedded, so `objectKey → data URI` is resolved before the render. */
export type ImageResolver = (objectKey: string) => string | null;

export function formatPercentage(pct: number | null): string {
  // A6: one decimal. The stored value carries three (§5.5); this is display, not a second
  // rounding of the stored number.
  return pct === null ? 'N/A' : `${pct.toFixed(1)}%`;
}

export function formatMarks(raw: number, max: number): string {
  return `${raw} / ${max}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  // Fixed locale and calendar: `toLocaleDateString()` with the host's default would make
  // the same payload render differently on two machines.
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = MONTHS[date.getUTCMonth()];
  return `${day} ${month} ${date.getUTCFullYear()}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function bandOf(bands: readonly ReportBand[], pct: number | null): ReportBand | null {
  if (pct === null || Number.isNaN(pct)) return null;
  for (const band of bands) {
    if (pct >= band.minPercentage) return band;
  }
  return null;
}

// ------------------------------------------------------------------------------ chrome

export function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="header">
      <div className="badge">5S</div>
      <div className="titles">
        <div className="title">{title}</div>
        <div className="subtitle">{subtitle}</div>
      </div>
      <div className="logo-card">
        <div className="org">AB Associates</div>
        <div className="tag">OPERATIONS CONSULTING</div>
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <div className="page-footer">
      <span>Lean 5S Report • AB Associates</span>
    </div>
  );
}

export function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-cell">
      <div className="meta-label">{label}</div>
      <div className="meta-value">{value}</div>
    </div>
  );
}

export function RatingPills({ bands }: { bands: readonly ReportBand[] }) {
  return (
    <div className="pills">
      {bands.map((band, index) => {
        const upper = index === 0 ? null : bands[index - 1]!.minPercentage - 1;
        const range =
          index === 0
            ? `≥ ${band.minPercentage}%`
            : band.minPercentage === 0
              ? `< ${upper! + 1}%`
              : `${band.minPercentage}–${upper}%`;
        return (
          <div key={band.token} className={`pill pill-${band.token}`}>
            {range} {band.label}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------------ S-wise table

export function SectionTable({
  sections,
  bands,
}: {
  sections: readonly SectionScorePayload[];
  bands: readonly ReportBand[];
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>S</th>
          <th className="num">Achieved</th>
          <th className="num">Max</th>
          <th className="num">Percentage</th>
        </tr>
      </thead>
      <tbody>
        {sections.map((section) => {
          const band = bandOf(bands, section.pct);
          return (
            <tr key={section.section}>
              <td>{S_SECTION_SHORT_LABELS[section.section]}</td>
              <td className="num">{section.raw}</td>
              <td className="num">{section.max}</td>
              {/* A fully-NA section prints N/A, never 0 (D4). */}
              <td className={`num ${band ? `band-${band.token}` : 'na'}`}>
                {formatPercentage(section.pct)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ----------------------------------------------------------------------- the radar web

/**
 * The 5S performance web (§4.1 item 4).
 *
 * A regular pentagon, one axis per S, labelled `1S…5S` with `achieved/max` beneath each in
 * orange, and the polygon plotted on **percentage** — which is what makes two Zones with
 * different applicable maxima comparable on one shape. A fully-NA section has no point on
 * its axis and is drawn at the centre, because `null` is not zero and the alternative
 * (omitting the vertex) would silently change the polygon into a quadrilateral.
 */
export function RadarWeb({
  sections,
  brand,
  size = 190,
}: {
  sections: readonly SectionScorePayload[];
  brand: Record<string, string>;
  size?: number;
}) {
  const centre = size / 2;
  const radius = size * 0.33;
  const points = sections.map((section, index) => {
    // Start at twelve o'clock and go clockwise, so 1S is at the top as in the sample.
    const angle = (Math.PI * 2 * index) / sections.length - Math.PI / 2;
    return { section, angle, cos: Math.cos(angle), sin: Math.sin(angle) };
  });

  const ring = (fraction: number) =>
    points
      .map((p) => `${round(centre + p.cos * radius * fraction)},${round(centre + p.sin * radius * fraction)}`)
      .join(' ');

  const polygon = points
    .map((p) => {
      const value = (p.section.pct ?? 0) / 100;
      return `${round(centre + p.cos * radius * value)},${round(centre + p.sin * radius * value)}`;
    })
    .join(' ');

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
    >
      {[0.25, 0.5, 0.75, 1].map((fraction) => (
        <polygon
          key={fraction}
          points={ring(fraction)}
          fill="none"
          stroke={brand.hairline ?? '#D8D2C4'}
          strokeWidth={0.6}
        />
      ))}
      {points.map((p) => (
        <line
          key={`axis-${p.section.section}`}
          x1={centre}
          y1={centre}
          x2={round(centre + p.cos * radius)}
          y2={round(centre + p.sin * radius)}
          stroke={brand.hairline ?? '#D8D2C4'}
          strokeWidth={0.6}
        />
      ))}
      <polygon
        points={polygon}
        fill={brand.accent ?? '#0B6E77'}
        fillOpacity={0.16}
        stroke={brand.ink ?? '#1D1B16'}
        strokeWidth={1.4}
      />
      {points.map((p) => {
        const labelRadius = radius + 15;
        const x = round(centre + p.cos * labelRadius);
        const y = round(centre + p.sin * labelRadius);
        return (
          <g key={`label-${p.section.section}`}>
            <text
              x={x}
              y={y}
              textAnchor="middle"
              fontSize={8}
              fontWeight={700}
              fill={brand.ink ?? '#1D1B16'}
            >
              {S_SECTION_SHORT_LABELS[p.section.section]}
            </text>
            <text
              x={x}
              y={y + 8}
              textAnchor="middle"
              fontSize={7}
              fill={brand.accent ?? '#0B6E77'}
            >
              {p.section.raw}/{p.section.max}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** §4.3 item 7: one horizontal bar per Zone, bar and percentage coloured by band. */
export function ZoneComparisonBars({
  zones,
  bands,
  brand,
}: {
  zones: readonly { zoneCode: string; zoneName: string; pct: number | null }[];
  bands: readonly ReportBand[];
  brand: Record<string, string>;
}) {
  const rowHeight = 16;
  const labelWidth = 132;
  const trackWidth = 330;
  const height = Math.max(rowHeight, zones.length * rowHeight + 6);

  return (
    <svg
      width={labelWidth + trackWidth + 46}
      height={height}
      viewBox={`0 0 ${labelWidth + trackWidth + 46} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
    >
      {zones.map((zone, index) => {
        const band = bandOf(bands, zone.pct);
        const y = index * rowHeight + 3;
        const width = zone.pct === null ? 0 : round((zone.pct / 100) * trackWidth);
        return (
          <g key={`${zone.zoneCode}-${index}`}>
            <text x={0} y={y + 9} fontSize={7.5} fill={brand.ink ?? '#1D1B16'}>
              {truncate(`${zone.zoneCode} — ${zone.zoneName}`, 30)}
            </text>
            <rect
              x={labelWidth}
              y={y}
              width={trackWidth}
              height={10}
              fill="none"
              stroke={brand.hairline ?? '#D8D2C4'}
              strokeWidth={0.75}
            />
            <rect
              x={labelWidth}
              y={y}
              width={width}
              height={10}
              fill={band?.color ?? (brand.inkSoft ?? '#5B5647')}
            />
            <text
              x={labelWidth + trackWidth + 6}
              y={y + 9}
              fontSize={7.5}
              fontWeight={700}
              fill={band?.color ?? (brand.inkSoft ?? '#5B5647')}
            >
              {formatPercentage(zone.pct)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// --------------------------------------------------------------------------- evidence

/** The caption §4.1 asks for: `Q{n} · {S label} · Score {n}`. */
export function photoCaption(photo: ReportPhoto): string {
  const parts: string[] = [];
  if (photo.questionGlobalOrder !== null) parts.push(`Q${photo.questionGlobalOrder}`);
  if (photo.section) parts.push(S_SECTION_SHORT_LABELS[photo.section]);
  if (photo.scoreAtCapture) parts.push(`Score ${scoreNumber(photo.scoreAtCapture)}`);
  return parts.join(' · ') || 'Walk-by observation';
}

function scoreNumber(value: string): string {
  return value === 'NA' ? 'NA' : value.replace('SCORE_', '');
}

/**
 * A photograph, or the placeholder that stands where a redacted one was (R-5).
 *
 * The redacted case prints "Photo removed" and keeps the caption and the remark: the
 * record says plainly that a photo was present and was removed, which is the difference
 * between redaction and deletion.
 */
export function Photo({ photo, resolve }: { photo: ReportPhoto; resolve: ImageResolver }) {
  if (photo.redacted || !photo.objectKey) {
    return <div className="redacted">Photo removed</div>;
  }
  const source = resolve(photo.objectKey);
  if (!source) {
    return <div className="redacted">Photo unavailable</div>;
  }
  return <img src={source} alt="" />;
}

export function round(value: number): number {
  // Two decimals is below print resolution and keeps the SVG path text byte-identical
  // across platforms whose floating-point printing differs in the last digit.
  return Math.round(value * 100) / 100;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function ratingLabel(payload: ReportPayload, pct: number | null): string {
  return bandOf(payload.bands, pct)?.label ?? 'N/A';
}
