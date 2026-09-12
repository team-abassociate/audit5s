import type { ReportPayload } from '@audit5s/contracts';

/**
 * The stylesheet, built from the payload's **frozen** tokens.
 *
 * Two constraints govern every rule here (STACK.md §5, HANDOFF.md §4):
 *
 *   * **No JavaScript-dependent layout.** Nothing is measured, positioned or sized by
 *     script. The page is CSS `@page` plus flow layout, so moving the renderer to
 *     WeasyPrint is a renderer change rather than a rewrite — which is the whole reason
 *     the tripwire in STACK.md §8 ("RAM below 4 GB → switch to WeasyPrint") is cheap.
 *   * **Determinism.** No animation, no transition, no web font fetched at render time,
 *     no `currentColor` resolved against a system theme. The same payload has to produce
 *     the same bytes, and a font that arrives over the network is the classic way that
 *     stops being true.
 *
 * Colours come from `payload.bands` / `payload.brand` rather than from `packages/domain`,
 * so a report reopened in December keeps the palette it was issued with even if the
 * business repaints the scale (§10.2).
 */
export function reportStyles(payload: ReportPayload): string {
  const brand = payload.brand;
  const bandRules = payload.bands
    .map(
      (band) => `
.band-${band.token} { color: ${band.color}; }
.tint-${band.token} { background: ${band.tint}; color: ${band.color}; }
.pill-${band.token} { background: ${band.tint}; color: ${band.color}; border-color: ${band.color}; }`,
    )
    .join('\n');

  const responseRules = Object.entries(payload.responseTokens)
    .map(([key, token]) => `.response-${key} { color: ${token.color}; }`)
    .join('\n');

  return `
/* A4 portrait, English (A5). The footer is a running element so every page carries it
   without the template knowing where the pages break — which is the part a JS-measured
   layout would have had to compute. */
@page {
  size: A4 portrait;
  margin: 14mm 12mm 16mm 12mm;
  @bottom-left { content: "Lean 5S Report • AB Associates"; }
  @bottom-right { content: "Page " counter(page); }
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  /* System stack only: nothing is fetched, so the render cannot vary with the network. */
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-size: 9.5pt;
  line-height: 1.35;
  color: #1A1A1A;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* Chromium's own header/footer is disabled in the launch options; this is the printed
   footer, repeated by fixed positioning on each page box. */
.page-footer {
  position: fixed;
  bottom: -10mm;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  font-size: 7.5pt;
  color: #7A6A66;
}

/* ------------------------------------------------------------------ header band (§3.5) */
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  background: ${brand.maroon};
  color: #FFFFFF;
  padding: 10px 12px;
  border-radius: 4px;
}
.header .badge {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: ${brand.orange};
  color: #FFFFFF;
  font-weight: 700;
  font-size: 13pt;
  display: flex;
  align-items: center;
  justify-content: center;
}
.header .titles { flex: 1 1 auto; }
.header .title { font-size: 14pt; font-weight: 700; letter-spacing: 0.4px; }
.header .subtitle { font-size: 8.5pt; opacity: 0.88; margin-top: 1px; }
.header .logo-card {
  flex: 0 0 auto;
  background: #FFFFFF;
  color: ${brand.maroon};
  border-radius: 4px;
  padding: 6px 9px;
  text-align: right;
  line-height: 1.15;
}
.header .logo-card .org { font-weight: 700; font-size: 9pt; }
.header .logo-card .tag { font-size: 6.5pt; color: #6B5A56; letter-spacing: 0.3px; }

/* -------------------------------------------------------------- metadata grid (§4.1.2) */
.meta-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px 10px;
  margin-top: 10px;
}
.meta-cell {
  border: 1px solid ${brand.tableBorder};
  border-radius: 3px;
  padding: 5px 7px;
  background: ${brand.rowTintA};
}
.meta-label {
  font-size: 6.5pt;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: #8A7772;
}
.meta-value { font-size: 10pt; font-weight: 700; margin-top: 1px; }

/* ------------------------------------------------------------------------ section rule */
h2.section-title {
  font-size: 9pt;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: ${brand.maroon};
  margin: 14px 0 5px;
  padding-bottom: 3px;
  border-bottom: 2px solid ${brand.orange};
}

/* --------------------------------------------------------------------------- tables */
table { width: 100%; border-collapse: collapse; }
th, td {
  border: 1px solid ${brand.tableBorder};
  padding: 3.5px 6px;
  text-align: left;
  vertical-align: top;
}
thead th {
  background: ${brand.maroon};
  color: #FFFFFF;
  font-size: 7pt;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  font-weight: 600;
}
tbody tr:nth-child(odd) { background: ${brand.rowTintA}; }
tbody tr:nth-child(even) { background: ${brand.rowTintB}; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.centre { text-align: center; }
/* A section header inside the checklist, carrying its subtotal. */
tbody tr.section-row, tbody tr.section-row td {
  background: ${brand.maroon};
  color: #FFFFFF;
  font-weight: 700;
  font-size: 8pt;
  letter-spacing: 0.4px;
}
tbody tr.total-row, tbody tr.total-row td {
  background: ${brand.rowTintB};
  font-weight: 700;
  border-top: 2px solid ${brand.maroon};
}
.q-remark { display: block; font-size: 7.5pt; color: #6B5A56; margin-top: 1.5px; }
.na { color: #6B7280; }

/* ----------------------------------------------------------- radar + verification row */
.web-row { display: flex; gap: 10px; align-items: stretch; margin-top: 8px; }
.verification {
  flex: 0 0 32%;
  border: 1px solid ${brand.tableBorder};
  border-radius: 3px;
  padding: 6px;
  background: ${brand.rowTintA};
  text-align: center;
}
.verification .selfie {
  width: 100%;
  height: auto;
  max-height: 52mm;
  object-fit: cover;
  border-radius: 3px;
  border: 1px solid ${brand.tableBorder};
}
.radar-box {
  flex: 1 1 auto;
  border: 1px solid ${brand.tableBorder};
  border-radius: 3px;
  padding: 6px;
  text-align: center;
}
.caption { font-size: 7pt; color: #6B5A56; margin-top: 3px; }

/* ------------------------------------------------------------- rating-scale pills */
.pills { display: flex; gap: 6px; margin-top: 8px; }
.pill {
  flex: 1 1 0;
  border: 1px solid;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 7.5pt;
  font-weight: 600;
  text-align: center;
}

/* ------------------------------------------------------------------------- evidence */
.good-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;   /* §4.1: two per row, side by side */
  gap: 8px;
  margin-top: 6px;
}
.photo-card {
  border: 1px solid ${brand.tableBorder};
  border-radius: 3px;
  padding: 5px;
  background: #FFFFFF;
  /* Paper-friendly: a photo never starts a page of its own (§4.1 item 8). */
  break-inside: avoid;
}
.photo-card img { width: 100%; height: auto; max-height: 62mm; object-fit: contain; }
.photo-caption { font-size: 7.5pt; font-weight: 600; margin-top: 3px; }
.photo-remark { font-size: 7pt; color: #6B5A56; }

.nc-row {
  display: grid;
  grid-template-columns: 1fr 1fr;   /* §4.1: photo left, right half reserved */
  gap: 8px;
  margin-top: 8px;
  break-inside: avoid;
}
/*
 * The initial report's right half: a light placeholder frame and NO TEXT WHATSOEVER
 * (§10.3-A, stated twice because it is the rule most likely to be "improved" by adding a
 * helpful "awaiting after-photo" label). The after-evidence report fills it.
 */
.nc-placeholder {
  border: 1px dashed ${brand.tableBorder};
  border-radius: 3px;
  background: #FCFAF9;
  min-height: 42mm;
}
.nc-answer {
  border: 1px solid ${brand.tableBorder};
  border-radius: 3px;
  padding: 5px;
  background: #FFFFFF;
}
.nc-answer img { width: 100%; height: auto; max-height: 52mm; object-fit: contain; }
.badge-good, .badge-nc, .badge-verified, .badge-not-possible, .badge-pending {
  display: inline-block;
  font-size: 6.5pt;
  font-weight: 700;
  letter-spacing: 0.4px;
  padding: 1px 5px;
  border-radius: 3px;
}
.badge-good { background: #E2F4E9; color: #1B7F4B; }
/* Exclamation in a filled yellow rectangle, per the brainstorm (§4.1 item 8). */
.badge-nc { background: #F5C518; color: #4A3B00; }
.badge-verified { background: #E2F4E9; color: #1B7F4B; }
.badge-not-possible { background: #FCE7E5; color: #B3261E; }
.badge-pending { background: #FDF3DB; color: #BE7D0F; }
.cta {
  display: inline-block;
  margin-top: 4px;
  padding: 3px 8px;
  border-radius: 3px;
  background: ${brand.orange};
  color: #FFFFFF !important;
  font-size: 7.5pt;
  font-weight: 700;
  text-decoration: none;
}
.redacted {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 42mm;
  border: 1px dashed ${brand.tableBorder};
  border-radius: 3px;
  background: #FCFAF9;
  color: #8A7772;
  font-size: 8pt;
}

/* --------------------------------------------------------------------------- notes */
.footnote {
  font-size: 7pt;
  color: #6B5A56;
  margin-top: 5px;
  font-style: italic;
}
.zone-remark {
  border-left: 3px solid ${brand.orange};
  background: ${brand.rowTintA};
  padding: 5px 8px;
  margin-top: 6px;
  font-size: 8.5pt;
}
.closure-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  margin-top: 6px;
}
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.avoid-break { break-inside: avoid; }
.page-break { break-before: page; }

${bandRules}
${responseRules}
`;
}
