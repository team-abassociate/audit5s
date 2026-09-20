import { renderToStaticMarkup } from 'react-dom/server';
import type { ReportPayload } from '@audit5s/contracts';
import type { ImageResolver } from './components';
import { reportStyles } from './styles';
import { SummaryReport } from './summary-report';
import { SUPPORTED_PAYLOAD_SCHEMA_VERSIONS, TEMPLATE_VERSION } from './version';
import { ZoneReport } from './zone-report';

export { TEMPLATE_VERSION } from './version';
export { REPORT_FONT_STACK, REPORT_MONO_STACK } from './styles';
export type { ImageResolver } from './components';

/**
 * Payload → HTML (§10.2).
 *
 * `renderToStaticMarkup` rather than `renderToString`: the output is a document, not an
 * application (N8/CH-3). There are no `data-reactroot` attributes, no hydration markers
 * and no client bundle — which is both what keeps the bytes stable and what makes the
 * WeasyPrint escape hatch real, since what leaves this function is plain HTML and CSS.
 *
 * The renderer is selected by the payload's **schema version**, not by today's code
 * (§10.5). A two-year-old snapshot still renders with the layout it was designed for, and
 * one written by a future version fails loudly here rather than rendering half of itself.
 */
export function renderReportHtml(payload: ReportPayload, resolve: ImageResolver): string {
  if (!SUPPORTED_PAYLOAD_SCHEMA_VERSIONS.includes(payload.schemaVersion)) {
    throw new Error(
      `Report payload schema version ${payload.schemaVersion} has no renderer in template ${TEMPLATE_VERSION}`,
    );
  }

  const body = renderToStaticMarkup(
    payload.kind === 'MULTI_ZONE_SUMMARY' ? (
      <SummaryReport payload={payload} resolve={resolve} />
    ) : (
      <ZoneReport payload={payload} resolve={resolve} />
    ),
  );

  const title =
    payload.kind === 'MULTI_ZONE_SUMMARY'
      ? `Lean 5S Summary Report — ${payload.unit.name}`
      : `Lean 5S Zone Report — ${payload.zones[0]?.zoneCode ?? ''}`;

  // Assembled as a string rather than rendered: `<html>` carries no React state, and
  // hand-writing it keeps the doctype and the charset exactly where a PDF engine expects
  // them rather than wherever a renderer decides to put them.
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${reportStyles(payload)}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
