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
import { formatDate, formatRupees, zoneDisplayLabel } from '@audit5s/domain';
import { sanitizeFileName } from '../reports/report-file-name';
import { REPORT_LOGO } from '../reports/templates/logo';

/**
 * The Kaizen Sheet as a PDF, in the `report-theme/kaizen-a3-template.html` design (owner,
 * 2026-10-11; no Excel, 2026-10-07). Rendered by `worker-report`'s Chromium like the 5S
 * reports, and like them with no network: the fonts are embedded, photos arrive as data URIs.
 *
 * The template's slots the Kaizen form does not collect (before/after notes, the deployment
 * plan, checked-by) print empty, to be filled by hand, as the template intends.
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
    renderToStaticMarkup(<title>{`Kaizen ${kaizen.kaizenNo}${kaizen.theme ? ` · ${kaizen.theme}` : ''}`}</title>),
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
        <div className="kz-logo"><img src={REPORT_LOGO} alt="AB Associates" /></div>
        <div className="kz-titleblock">
          <div className="kz-kicker">
            CONTINUOUS IMPROVEMENT · {kaizen.unitName.toUpperCase()} · {zoneDisplayLabel(kaizen.zoneCode, kaizen.zoneName).toUpperCase()}
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
        <span className="kz-label">Team members</span>
        <span>
          {[
            kaizen.teamMembers,
            kaizen.ideaBy && `idea by ${kaizen.ideaBy}`,
            kaizen.implementedBy && `implemented by ${kaizen.implementedBy}`,
          ].filter(Boolean).join(' · ')}
        </span>
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

      <main className="kz-main">
        <div className="kz-col">
          <section className="kz-box blue">
            <div className="kz-h">Problem <span className="kz-tag">5W1H</span></div>
            <div className="kz-ana-text"><Text value={kaizen.problem5w1h} /></div>
          </section>
          <section className="kz-box blue kz-fill">
            <div className="kz-h">Analysis <span className="kz-tag">7 QC TOOLS</span></div>
            <Text value={kaizen.analysis7qc} />
          </section>
          <section className="kz-box amber">
            <div className="kz-h">Root Cause <span className="kz-tag">4M</span></div>
            <Text value={kaizen.rootCause4m} />
          </section>
        </div>

        <div className="kz-col">
          <section className="kz-box amber">
            <div className="kz-h">Counter Measure</div>
            <div className="kz-cm">
              {numberedLines(kaizen.countermeasure).map((text, index) => (
                <span key={index} className="kz-text"><b>{index + 1}</b> {text}</span>
              ))}
            </div>
          </section>

          <div className="kz-ba">
            <Photo side="before" title="Before Counter Measure" src={photos.before} />
            <Photo side="after" title="After Counter Measure" src={photos.after} />
            <div className="kz-side">
              <div className="kz-list">
                <div className="kz-label">Waste attacked</div>
                {KAIZEN_WASTES.map((waste) => (
                  <span key={waste} className={kaizen.wastes.includes(waste) ? 'kz-check on' : 'kz-check'}>
                    {WASTE_LABELS[waste]}
                  </span>
                ))}
              </div>
              <div className="kz-list">
                <div className="kz-label">Impact · PQCDSM</div>
                {KAIZEN_PARAMETERS.map((parameter) => {
                  const on = kaizen.parameters.includes(parameter);
                  return (
                    <span key={parameter} className={on ? 'kz-imp' : 'kz-imp off'}>
                      <span>{PARAMETER_LABELS[parameter]}</span>
                      {/* Cost improves by going down. */}
                      <b>{on ? (parameter === 'COST' ? '▼' : '▲') : '–'}</b>
                    </span>
                  );
                })}
              </div>
            </div>
          </div>

          <section className="kz-box purple kz-hz">
            <div className="kz-hz-text">
              <div className="kz-h">Scope &amp; plan for horizontal deployment</div>
              <div />
            </div>
            <div className="kz-pills">
              <span className={kaizen.horizontalDeployment === true ? 'kz-pill on' : 'kz-pill'}>YES</span>
              <span className={kaizen.horizontalDeployment === false ? 'kz-pill on' : 'kz-pill'}>NO</span>
            </div>
          </section>

          <section className="kz-box green">
            <div className="kz-h">Benefits / Results After Implementation</div>
            <div className="kz-metrics">
              <Metric
                label="Annual saving"
                value={compactRupees(kaizen.annualSaving)}
                note={kaizen.annualSaving === null ? 'estimated' : `${formatRupees(kaizen.annualSaving)} a year`}
              />
              <Metric label="Wastes" value={`${kaizen.wastes.length}/${KAIZEN_WASTES.length}`} note="wastes attacked" />
              <Metric
                label="PQCDSM"
                value={`${kaizen.parameters.length}/${KAIZEN_PARAMETERS.length}`}
                note="parameters improved"
              />
              <Metric
                label="Cost to implement"
                value={compactRupees(kaizen.implementationCost)}
                note={costNote(kaizen.implementationCost)}
              />
            </div>
            <div className="kz-summary"><Text value={kaizen.benefits} /></div>
          </section>
        </div>
      </main>

      <footer className="kz-footer">
        <div className="kz-signs">
          <span className="kz-sign">PREPARED<i>{kaizen.authorName}</i></span>
          <span className="kz-sign">CHECKED<i /></span>
          <span className="kz-sign">APPROVED<i>{approval?.reviewerName ?? ''}</i></span>
        </div>
        <span>
          {kaizen.kaizenNo} · {STATUS_LABELS[kaizen.status]}
          {approval ? ` ${formatDate(approval.createdAt)}` : ''}
        </span>
      </footer>
    </div>
  );
}

/** The countermeasure as numbered steps: one per line, any numbering the writer typed dropped. */
export function numberedLines(value: string | null): string[] {
  return (value ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*(\d+[.)]|[-•*])\s*/, '').trim())
    .filter(Boolean);
}

/** Zero is an answer (it cost nothing), kept apart from not stated. */
export function costNote(value: number | null): string {
  if (value === null) return 'not stated';
  return value === 0 ? 'no cost' : formatRupees(value);
}

/** The metric card fits about seven characters at its size: ₹4.2L, not ₹4,20,000. */
export function compactRupees(value: number | null): string {
  if (value === null) return '—';
  const abs = Math.abs(value);
  const [unit, size] = abs >= 1e7 ? ['Cr', 1e7] : abs >= 1e5 ? ['L', 1e5] : abs >= 1e3 ? ['K', 1e3] : ['', 1];
  return `${value < 0 ? '-' : ''}₹${Math.round((abs / size) * 10) / 10}${unit}`;
}

function Text({ value }: { value: string | null }) {
  return value ? <span className="kz-text">{value}</span> : null;
}

function Meta({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="kz-label">{label}</div>
      <div className="kz-value"><Text value={value} /></div>
    </div>
  );
}

function Photo({ side, title, src }: { side: 'before' | 'after'; title: string; src: string | null }) {
  return (
    <div className={`kz-ba-col kz-${side}`}>
      <div className="kz-ba-h">{title}</div>
      <div className="kz-photo">{src ? <img src={src} alt="" /> : '[photo / sketch]'}</div>
      <div className="kz-desc"><span /></div>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="kz-metric">
      <div className="kz-label">{label}</div>
      <div className="kz-metric-v">{value}</div>
      <div className="kz-metric-n">{note}</div>
    </div>
  );
}
