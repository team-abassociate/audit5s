import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  KAIZEN_PARAMETERS,
  KAIZEN_WASTES,
  type KaizenDetail,
  type KaizenParameter,
  type KaizenStatus,
  type KaizenWaste,
} from '@audit5s/contracts';
import { formatDate, zoneDisplayLabel } from '@audit5s/domain';
import { sanitizeFileName } from '../reports/report-file-name';
import { REPORT_LOGO } from '../reports/templates/logo';

/**
 * The Kaizen Sheet as a PDF, in the "A3 Reimagined" theme (owner, 2026-10-07: a
 * redesigned sheet, no Excel). Rendered by `worker-report`'s Chromium like the 5S reports,
 * and like them with no network: the theme's fonts are embedded, photos arrive as data URIs.
 *
 * Colour follows PDCA: blue Plan (problem, analysis), amber Do (root cause, countermeasure),
 * green Check (results, wastes, PQCDSM), purple Act (horizontal deployment).
 */

/** `apps/api/assets`, from `src/modules/kaizens` under vitest and `dist/modules/kaizens` built. */
const ASSETS = resolve(__dirname, '..', '..', '..', 'assets');

let styles: string | null = null;

/** The theme plus its fonts, read once per process. */
function sheetStyles(): string {
  if (styles) return styles;
  const font = (file: string) => `url(data:font/woff2;base64,${readFileSync(resolve(ASSETS, 'fonts', file)).toString('base64')}) format('woff2')`;
  styles = [
    `@font-face { font-family: 'Archivo'; font-weight: 400 900; src: ${font('archivo-latin-var.woff2')}; }`,
    `@font-face { font-family: 'IBM Plex Mono'; font-weight: 400; src: ${font('ibm-plex-mono-400-latin.woff2')}; }`,
    `@font-face { font-family: 'IBM Plex Mono'; font-weight: 600; src: ${font('ibm-plex-mono-600-latin.woff2')}; }`,
    readFileSync(resolve(ASSETS, 'kaizen-sheet.css'), 'utf8'),
    // Long answers run onto a second page rather than being cut off at the A4 edge.
    `body { margin: 0; } .kz-page { height: auto; min-height: var(--kz-page-h); }
     .kz-text { white-space: pre-wrap; overflow-wrap: anywhere; }
     .kz-row { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: var(--kz-gap); }
     .kz-logo { height: 34px; align-self: center; }
     .kz-head-main { flex: 1; }
     .kz-empty { color: var(--kz-faint); }
     .kz-box, .kz-callout, .kz-photo { break-inside: avoid; }`,
  ].join('\n');
  return styles;
}

const WASTE_LABELS: Record<KaizenWaste, string> = {
  DEFECTS: 'Defects',
  OVERPRODUCTION: 'Overproduction',
  WAITING_TIME: 'Waiting time',
  NON_UTILIZED_TALENT: 'Non-utilized talent',
  TRANSPORTATION: 'Transportation',
  INVENTORY: 'Inventory',
  MOTION: 'Motion',
  EXTRA_PROCESSING: 'Extra-processing',
};

const PARAMETER_LABELS: Record<KaizenParameter, string> = {
  PRODUCTIVITY: 'Productivity',
  QUALITY: 'Quality',
  COST: 'Cost',
  DELIVERY: 'Delivery',
  SAFETY: 'Safety',
  MORALE: 'Morale',
};

const STATUS_LABELS: Record<KaizenStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  SENT_BACK: 'Sent back',
  REJECTED: 'Rejected',
};

const RUPEES = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export interface KaizenSheetPhotos {
  before: string | null;
  after: string | null;
}

/** The day on the sheet: when it was implemented, or when it was started if not yet known. */
function sheetDate(kaizen: Pick<KaizenDetail, 'implementedOn' | 'createdAt'>): string {
  return formatDate(kaizen.implementedOn ?? kaizen.createdAt);
}

/** `{Unit} - Zone {n} {Zone name} - {date}.pdf` (owner, 2026-10-07). */
export function kaizenSheetFileName(
  kaizen: Pick<KaizenDetail, 'unitName' | 'zoneCode' | 'zoneName' | 'implementedOn' | 'createdAt'>,
): string {
  const zone = zoneDisplayLabel(kaizen.zoneCode, kaizen.zoneName).replace(' — ', ' ');
  return `${sanitizeFileName([kaizen.unitName, zone, sheetDate(kaizen)].join(' - '), 'kaizen')}.pdf`;
}

export function renderKaizenSheetHtml(kaizen: KaizenDetail, photos: KaizenSheetPhotos): string {
  const body = renderToStaticMarkup(<KaizenSheet kaizen={kaizen} photos={photos} />);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    // React escapes the title's text; the stylesheet is ours.
    renderToStaticMarkup(<title>{`Kaizen Sheet — ${kaizen.kaizenNo}`}</title>),
    `<style>${sheetStyles()}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('\n');
}

function KaizenSheet({ kaizen, photos }: { kaizen: KaizenDetail; photos: KaizenSheetPhotos }) {
  const approval = [...kaizen.reviews].reverse().find((review) => review.decision === 'APPROVED');
  return (
    <div className="kz-page">
      <header className="kz-header">
        <img className="kz-logo" src={REPORT_LOGO} alt="AB Associates" />
        <div className="kz-head-main">
          <div className="kz-kicker">
            KAIZEN · {kaizen.unitName.toUpperCase()} · {zoneDisplayLabel(kaizen.zoneCode, kaizen.zoneName).toUpperCase()}
          </div>
          <h1 className="kz-title">KAIZEN SHEET</h1>
        </div>
        <div className="kz-meta">
          <Meta label="Kaizen No." value={kaizen.kaizenNo} />
          <Meta label="Date" value={sheetDate(kaizen)} />
          <Meta label="Machine" value={kaizen.machine} />
          <Meta label="Line / Area" value={kaizen.lineArea} />
        </div>
      </header>

      <div className="kz-team">
        <span className="kz-label">Team</span> <Text value={kaizen.teamMembers} />
        <span className="kz-label">Idea by</span> <Text value={kaizen.ideaBy} />
        <span className="kz-label">Implemented by</span> <Text value={kaizen.implementedBy} />
      </div>

      <div className="kz-row">
        <div className="kz-callout blue">
          <div className="kz-label">Kaizen theme</div>
          <div className="kz-value"><Text value={kaizen.theme} /></div>
        </div>
        <div className="kz-callout green">
          <div className="kz-label">Target &amp; target date</div>
          <div className="kz-value"><Text value={kaizen.target} /></div>
        </div>
      </div>

      <div className="kz-row">
        <Box zone="blue" title="Problem" tag="5W1H · PLAN" value={kaizen.problem5w1h} />
        <Box zone="blue" title="Analysis" tag="7 QC TOOLS" value={kaizen.analysis7qc} />
      </div>
      <div className="kz-row">
        <Box zone="amber" title="Root cause" tag="4M · DO" value={kaizen.rootCause4m} />
        <Box zone="amber" title="Countermeasure" tag="DO" value={kaizen.countermeasure} />
      </div>

      <div className="kz-row">
        <Photo side="before" title="Before countermeasure" src={photos.before} />
        <Photo side="after" title="After countermeasure" src={photos.after} />
      </div>

      <section className="kz-box green">
        <div className="kz-h">Results <span className="kz-tag">CHECK</span></div>
        <div className="kz-metrics">
          <Metric value={kaizen.annualSaving === null ? '—' : `₹${RUPEES.format(kaizen.annualSaving)}`} name="Estimated annual saving" />
          <Metric value={`${kaizen.wastes.length}/${KAIZEN_WASTES.length}`} name="Wastes attacked" />
          <Metric value={`${kaizen.parameters.length}/${KAIZEN_PARAMETERS.length}`} name="PQCDSM improved" />
          <Metric value={STATUS_LABELS[kaizen.status]} name="Status" />
        </div>
        <div className="kz-label">Benefits / results after implementation</div>
        <Text value={kaizen.benefits} />
        <div className="kz-row">
          <Checklist title="Waste attacked" items={KAIZEN_WASTES.map((w) => [WASTE_LABELS[w], kaizen.wastes.includes(w)])} />
          <Checklist
            title="PQCDSM"
            items={KAIZEN_PARAMETERS.map((p) => [PARAMETER_LABELS[p], kaizen.parameters.includes(p)])}
          />
        </div>
      </section>

      <section className="kz-box purple">
        <div className="kz-h">Horizontal deployment <span className="kz-tag">ACT</span></div>
        <div className="kz-team" style={{ background: 'transparent', padding: 0 }}>
          <span className={kaizen.horizontalDeployment === true ? 'kz-pill on' : 'kz-pill'}>Yes</span>
          <span className={kaizen.horizontalDeployment === false ? 'kz-pill on' : 'kz-pill'}>No</span>
        </div>
      </section>

      <footer className="kz-footer">
        <span>{kaizen.kaizenNo} · by {kaizen.authorName}</span>
        <span>
          {approval
            ? `Approved by ${approval.reviewerName}, ${formatDate(approval.createdAt)}`
            : STATUS_LABELS[kaizen.status]}
        </span>
      </footer>
    </div>
  );
}

function Text({ value }: { value: string | null }) {
  return value ? <span className="kz-text">{value}</span> : <span className="kz-empty">—</span>;
}

function Meta({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="kz-label">{label}</div>
      <div className="kz-value"><Text value={value} /></div>
    </div>
  );
}

function Box({ zone, title, tag, value }: { zone: string; title: string; tag: string; value: string | null }) {
  return (
    <section className={`kz-box ${zone}`}>
      <div className="kz-h">
        {title} <span className="kz-tag">{tag}</span>
      </div>
      <Text value={value} />
    </section>
  );
}

function Photo({ side, title, src }: { side: 'before' | 'after'; title: string; src: string | null }) {
  return (
    <section className={`kz-${side}`}>
      <div className="kz-h">{title}</div>
      <div className="kz-photo">{src ? <img src={src} alt={title} /> : <span className="kz-empty">No photo</span>}</div>
    </section>
  );
}

function Metric({ value, name }: { value: string; name: string }) {
  return (
    <div className="kz-metric">
      <div className="kz-metric-v">{value}</div>
      <div className="kz-metric-n">{name}</div>
    </div>
  );
}

function Checklist({ title, items }: { title: string; items: [string, boolean][] }) {
  return (
    <div className="kz-checklist">
      <div className="kz-label">{title}</div>
      {items.map(([label, on]) => (
        <div key={label} className={on ? 'kz-check on' : 'kz-check'}>
          {label}
        </div>
      ))}
    </div>
  );
}
