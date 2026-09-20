import type {
  ReportBand,
  ReportPayload,
  ReportPhoto,
  SectionScorePayload,
} from './payload-types';
import { S_SECTION_SHORT_LABELS } from '@audit5s/domain';
import { encodeQr } from './qr';

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
            <span className="swatch" />
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

/**
 * The five-S scorecard as index bars, ahead of the ledger `SectionTable` — the same
 * numbers, read at a glance: each bar tinted by its own band, an em-dash and a hatched
 * track for a fully-NA section (never a zero-length coloured bar, D4), and the 85% target
 * marked once on every row so every S is read against the same line.
 */
export function SectionBars({
  sections,
  bands,
}: {
  sections: readonly SectionScorePayload[];
  bands: readonly ReportBand[];
}) {
  return (
    <div className="bars">
      {sections.map((section) => {
        const band = bandOf(bands, section.pct);
        return (
          <div className="bar-row" key={section.section}>
            <span className="bar-label">{S_SECTION_SHORT_LABELS[section.section]}</span>
            <div className={`bar-track ${section.pct === null ? 'na' : ''}`}>
              {section.pct !== null ? (
                <div
                  className={`bar-fill ${band ? `band-fill-${band.token}` : ''}`}
                  style={{ width: `${section.pct}%` }}
                />
              ) : null}
              <div className="bar-target" />
            </div>
            <span className="bar-val">
              {section.pct === null ? 'N/A' : formatMarks(section.raw, section.max)}
            </span>
          </div>
        );
      })}
      <div className="bar-foot">Target 85% — dashed rule marks the line above.</div>
    </div>
  );
}

// ----------------------------------------------------------------------- the radar web

/**
 * The 5S performance web (§4.1 item 4).
 *
 * A regular pentagon, one axis per S, labelled `1S…5S` with `achieved/max` beneath each,
 * and the polygon plotted on **percentage** — which is what makes two Zones with different
 * applicable maxima comparable on one shape. A fully-NA section has no point on its axis
 * and is drawn at the centre, because `null` is not zero and the alternative (omitting the
 * vertex) would silently change the polygon into a quadrilateral.
 *
 * Each vertex is tinted by its **own** band — the same "matrix cell coloured by its own
 * score" rule the Zone-wise matrix uses — so a strong Zone with one weak S shows that S in
 * red rather than hiding it inside a green shape. The dashed ring is the rating scale's
 * lowest boundary (§3 in the design brief), always in that band's colour regardless of how
 * this Zone scored, because it marks the line rather than this Zone's position on it.
 */
export function RadarWeb({
  sections,
  bands,
  brand,
  size = 190,
}: {
  sections: readonly SectionScorePayload[];
  bands: readonly ReportBand[];
  brand: Record<string, string>;
  size?: number;
}) {
  const centre = size / 2;
  const radius = size * 0.33;
  const target = bands[bands.length - 1]?.color ?? brand.accent ?? '#B3261E';
  const points = sections.map((section, index) => {
    // Start at twelve o'clock and go clockwise, so 1S is at the top as in the sample.
    const angle = (Math.PI * 2 * index) / sections.length - Math.PI / 2;
    return { section, angle, cos: Math.cos(angle), sin: Math.sin(angle), band: bandOf(bands, section.pct) };
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
      {[0.25, 0.5, 0.75].map((fraction) => (
        <polygon
          key={fraction}
          points={ring(fraction)}
          fill="none"
          stroke={brand.hairline ?? '#D8D8D3'}
          strokeWidth={0.6}
        />
      ))}
      <polygon
        points={ring(1)}
        fill="none"
        stroke={brand.ink ?? '#101112'}
        strokeWidth={1}
      />
      {/* The 85% target line (GEMBA-BOARD.md §6 "Trend chart"), drawn on the shape itself. */}
      <polygon points={ring(0.85)} fill="none" stroke={target} strokeWidth={1} strokeDasharray="3 3" />
      {points.map((p) => (
        <line
          key={`axis-${p.section.section}`}
          x1={centre}
          y1={centre}
          x2={round(centre + p.cos * radius)}
          y2={round(centre + p.sin * radius)}
          stroke={brand.hairline ?? '#D8D8D3'}
          strokeWidth={0.6}
        />
      ))}
      <polygon
        points={polygon}
        fill={brand.ink ?? '#101112'}
        fillOpacity={0.06}
        stroke={brand.ink ?? '#101112'}
        strokeWidth={1.4}
      />
      {points.map((p) => {
        const value = (p.section.pct ?? 0) / 100;
        return (
          <circle
            key={`dot-${p.section.section}`}
            cx={round(centre + p.cos * radius * value)}
            cy={round(centre + p.sin * radius * value)}
            r={2.6}
            fill={p.band?.color ?? (brand.inkSoft ?? '#5B5B57')}
          />
        );
      })}
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
              fill={brand.ink ?? '#101112'}
            >
              {S_SECTION_SHORT_LABELS[p.section.section]}
            </text>
            <text
              x={x}
              y={y + 8}
              textAnchor="middle"
              fontSize={7}
              fill={p.band?.color ?? (brand.inkSoft ?? '#5B5B57')}
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
            <text x={0} y={y + 9} fontSize={7.5} fill={brand.ink ?? '#101112'}>
              {truncate(`${zone.zoneCode} — ${zone.zoneName}`, 30)}
            </text>
            <rect
              x={labelWidth}
              y={y}
              width={trackWidth}
              height={10}
              fill="none"
              stroke={brand.hairline ?? '#D8D8D3'}
              strokeWidth={0.75}
            />
            <rect
              x={labelWidth}
              y={y}
              width={width}
              height={10}
              fill={band?.color ?? (brand.inkSoft ?? '#5B5B57')}
            />
            <text
              x={labelWidth + trackWidth + 6}
              y={y + 9}
              fontSize={7.5}
              fontWeight={700}
              fill={band?.color ?? (brand.inkSoft ?? '#5B5B57')}
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

/**
 * The corrective-action link, carried three ways so that no viewer can lose all of them.
 *
 * The problem this solves is stated in `qr.ts`: a lone `<a>` produced a link annotation
 * ten pixels tall on a phone, in viewers that honour annotations at all. So the block is
 * drawn as one large anchor — the whole card is the tap target now, not a line of 7.5 pt
 * text — wrapping a scannable square and the address in full.
 *
 * **The URL is printed as text deliberately, and it is not a leak.** The secret is already
 * in the document: it is the annotation's `/URI`, in the PDF's own bytes, on the same page.
 * Printing it changes nothing about who can read the file and is the only thing that helps
 * a reader whose viewer offers neither a tappable link nor a second device to scan with.
 * §10.4's security properties live in the token — 256 random bits, hashed at rest, one
 * corrective action, expiring — and never in the link being hard to see.
 */
export function CorrectiveActionLink({ url }: { url: string }) {
  const qr = encodeQr(url);
  return (
    <a className="cta" href={url}>
      <svg
        className="cta-qr"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        xmlns="http://www.w3.org/2000/svg"
        shapeRendering="crispEdges"
        role="img"
        aria-label="Corrective action link"
      >
        {/* The quiet zone has to be white, not merely empty: this square sits on the
            page's faint column grid, and a scanner reads that as part of the symbol. */}
        <rect width={qr.size} height={qr.size} fill="#FFFFFF" />
        <path d={qr.path} fill="currentColor" />
      </svg>
      <span className="cta-text">
        <span className="cta-label">Scan or tap — submit corrective action ▸</span>
        <span className="cta-hint">Photograph the completed work. No app or login needed.</span>
        {/* Wrapped at every character: a 43-character secret has no spaces to break at,
            and without this it would run past the card and be clipped. */}
        <span className="cta-url">{url}</span>
      </span>
    </a>
  );
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
