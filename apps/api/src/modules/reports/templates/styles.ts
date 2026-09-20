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
 * The type scale below deliberately does **not** borrow the product's Archivo / DM Mono
 * pairing (`docs/design/GEMBA-BOARD.md` §4): that pairing is fetched from Google Fonts, and
 * this pipeline may not fetch anything at render time (R-14). What it does borrow is the
 * same *discipline* — a flat, unrounded, functionally-coloured page instead of a rounded,
 * softly-shadowed one — expressed in the system serif-free stack that was already safe to
 * ship. That is deliberate for a second reason: these PDFs leave the building and sit in
 * front of MNC clients, so the sharp, structured, no-ornament register reads as an audit
 * document rather than a dashboard printed onto paper.
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
.pill-${band.token} { background: ${band.tint}; color: ${band.color}; border-color: ${band.color}; }
.band-fill-${band.token} { background: ${band.color}; }`,
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
  line-height: 1.4;
  color: ${brand.ink};
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  /* The technical-manual register: a faint column grid on every page, not a decoration —
     a drawing sheet's guide lines, printed rather than blank. */
  background-image: repeating-linear-gradient(
    90deg, rgba(0, 0, 0, 0.04) 0, rgba(0, 0, 0, 0.04) 1px, transparent 1px, transparent calc(100% / 12)
  );
  counter-reset: clause;
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
  border-top: 0.75px solid ${brand.hairline};
  padding-top: 2px;
  font-size: 7.5pt;
  letter-spacing: 0.02em;
  color: ${brand.inkSoft};
}

/* ------------------------------------------------------------------ header band (§3.5)
   Flat, unrounded, ink-on-white: a masthead rather than a rounded app card. The two
   blocks (mark + title on the left, firm identity on the right) sit at opposite ends of
   one hard rule, so the page reads immediately as one firm's letterhead. */
.header {
  display: flex;
  align-items: stretch;
  gap: 12px;
  border-bottom: 2px solid ${brand.ink};
  padding-bottom: 10px;
}
.header .badge {
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  border: 1.5px solid ${brand.ink};
  background: ${brand.ink};
  color: #FFFFFF;
  font-weight: 700;
  font-size: 11pt;
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  justify-content: center;
}
.header .titles { flex: 1 1 auto; align-self: center; }
.header .title {
  font-size: 13.5pt;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${brand.ink};
}
.header .subtitle {
  font-size: 8pt;
  color: ${brand.inkSoft};
  margin-top: 1px;
  letter-spacing: 0.01em;
}
.header .logo-card {
  flex: 0 0 auto;
  align-self: center;
  border-left: 1.5px solid ${brand.hairline};
  padding-left: 10px;
  text-align: right;
  line-height: 1.2;
}
.header .logo-card .org {
  font-weight: 700;
  font-size: 9.5pt;
  letter-spacing: 0.03em;
  color: ${brand.ink};
}
.header .logo-card .tag {
  font-size: 6.5pt;
  color: ${brand.accent};
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 600;
}

/* -------------------------------------------------------------- metadata grid (§4.1.2)
   Each cell is a flat labelled tile: a hairline frame, no fill, no radius — a data field
   on a form, not a card floating on a board. */
.meta-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0;
  margin-top: 10px;
  border: 1px solid ${brand.hairline};
  border-bottom: none;
  border-right: none;
}
.meta-cell {
  border-right: 1px solid ${brand.hairline};
  border-bottom: 1px solid ${brand.hairline};
  padding: 5px 8px 6px;
}
.meta-label {
  font-size: 6.5pt;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: ${brand.inkSoft};
}
.meta-value {
  font-size: 10pt;
  font-weight: 700;
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------------ section rule
   A section opens with a short uppercase, letter-spaced label under a hard ink rule —
   the print equivalent of the product's tape marker, without the texture: this is a
   client deliverable, not a shop-floor board. The "§N" is a CSS counter, not text in the
   markup — the heading's own text stays exactly what §4.1–§4.3 name it. */
h2.section-title {
  font-size: 8.5pt;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${brand.ink};
  margin: 16px 0 6px;
  padding-bottom: 3px;
  border-bottom: 1.5px solid ${brand.ink};
}
h2.section-title::before {
  counter-increment: clause;
  content: "\\00A7" counter(clause) "  ";
  color: ${brand.accent};
  font-family: "Courier New", Courier, monospace;
}

/* --------------------------------------------------------------------------- tables */
table { width: 100%; border-collapse: collapse; }
th, td {
  border: 1px solid ${brand.hairline};
  padding: 3.5px 6px;
  text-align: left;
  vertical-align: top;
}
thead th {
  background: ${brand.ink};
  color: #FFFFFF;
  font-size: 7pt;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  font-weight: 600;
}
tbody tr:nth-child(odd) { background: #FFFFFF; }
tbody tr:nth-child(even) { background: ${brand.panel}; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.centre { text-align: center; font-variant-numeric: tabular-nums; }
/* A section header inside the checklist, carrying its subtotal — a light panel between
   two hard ink rules rather than a solid fill, so the subtotal's own band colour (below)
   still reads instead of disappearing into a dark background. */
tbody tr.section-row, tbody tr.section-row td {
  background: ${brand.panel};
  color: ${brand.ink};
  font-weight: 800;
  font-size: 8pt;
  letter-spacing: 0.05em;
  border-top: 1.5px solid ${brand.ink};
  border-bottom: 1.5px solid ${brand.ink};
}
tbody tr.total-row, tbody tr.total-row td {
  background: ${brand.panel};
  font-weight: 700;
  border-top: 2px solid ${brand.ink};
}
.q-remark { display: block; font-size: 7.5pt; color: ${brand.inkSoft}; margin-top: 1.5px; }
.na { color: ${brand.inkSoft}; }

/* ----------------------------------------------------------- radar + verification row
   Twin panels of equal weight — identity on the left, the five-S shape on the right —
   divided by one hairline rather than floating as two separate cards. */
.web-row {
  display: flex;
  align-items: stretch;
  margin-top: 10px;
  border: 1px solid ${brand.hairline};
}
.verification {
  flex: 0 0 32%;
  padding: 8px;
  border-right: 1px solid ${brand.hairline};
  text-align: center;
}
.verification .selfie {
  width: 100%;
  height: auto;
  max-height: 52mm;
  object-fit: cover;
  border: 1px solid ${brand.hairline};
}
.radar-box {
  flex: 1 1 auto;
  padding: 8px;
  text-align: center;
}
.caption { font-size: 7pt; color: ${brand.inkSoft}; margin-top: 3px; }

/* ------------------------------------------------------------- rating-scale pills
   Outlined chips, not filled capsules: colour still marks the band, carried once more by
   a small filled swatch so it reads even where a reader's printer renders text in black. */
.pills { display: flex; gap: 6px; margin-top: 8px; }
.pill {
  flex: 1 1 0;
  border: 1.25px solid;
  padding: 3px 8px;
  font-size: 7.5pt;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-align: center;
  background: #FFFFFF !important;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.pill .swatch { width: 8px; height: 8px; border: 1px solid currentColor; background: currentColor; flex: 0 0 auto; }

/* --------------------------------------------------------------- score index bars (§2)
   The same S-wise numbers as the ledger table below, read at a glance: one bar per S,
   tinted by its own band, the 85% target marked once on every row. */
.bars { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
.bar-row { display: grid; grid-template-columns: 22px 1fr 54px; align-items: center; gap: 8px; }
.bar-label { font-size: 7.5pt; font-weight: 800; }
.bar-track {
  position: relative;
  height: 7px;
  background: ${brand.hairline};
}
.bar-track.na {
  background: repeating-linear-gradient(-45deg, ${brand.hairline} 0 4px, transparent 4px 8px);
}
.bar-fill { position: absolute; left: 0; top: 0; bottom: 0; }
.bar-target {
  position: absolute;
  top: -2px;
  bottom: -2px;
  left: 85%;
  width: 0;
  border-left: 1.25px dashed ${payload.bands[payload.bands.length - 1]?.color ?? brand.accent};
}
.bar-val { font-size: 7.5pt; text-align: right; font-variant-numeric: tabular-nums; }
.bar-foot { font-size: 6.5pt; font-style: italic; color: ${brand.inkSoft}; margin-top: 1px; }

/* ------------------------------------------------------------------------- evidence */
.good-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;   /* §4.1: two per row, side by side */
  gap: 8px;
  margin-top: 6px;
}
.photo-card {
  border: 1px solid ${brand.hairline};
  padding: 5px;
  background: #FFFFFF;
  /* Paper-friendly: a photo never starts a page of its own (§4.1 item 8). */
  break-inside: avoid;
}
.photo-card img { width: 100%; height: auto; max-height: 62mm; object-fit: contain; }
.photo-caption { font-size: 7.5pt; font-weight: 600; margin-top: 3px; }
.photo-remark { font-size: 7pt; color: ${brand.inkSoft}; }

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
  border: 1px dashed ${brand.hairline};
  background: ${brand.panel};
  min-height: 42mm;
}
.nc-answer {
  border: 1px solid ${brand.hairline};
  padding: 5px;
  background: #FFFFFF;
}
.nc-answer img { width: 100%; height: auto; max-height: 52mm; object-fit: contain; }
.badge-good, .badge-nc, .badge-verified, .badge-not-possible, .badge-pending {
  display: inline-block;
  font-size: 6.5pt;
  font-weight: 700;
  letter-spacing: 0.05em;
  padding: 1px 5px;
  border: 1px solid currentColor;
}
.badge-good { color: #1B7F4B; background: #E2F4E9; }
.badge-nc { color: #B3261E; background: #FCE7E5; }
.badge-verified { color: #1B7F4B; background: #E2F4E9; }
.badge-not-possible { color: #B3261E; background: #FCE7E5; }
.badge-pending { color: #BE7D0F; background: #FDF3DB; }
/*
 * The corrective-action link.
 *
 * This was a 7.5 pt line of text, and Chromium duly gave it a link annotation 15 pt tall.
 * Fitted to a phone screen that is a target about ten pixels high, which is why the link
 * "worked on a computer" and did nothing in a hand. The whole card is the anchor now:
 * display: flex on an <a>, so the annotation Chromium emits covers the QR code, both
 * lines of label and the address. Measured off the printed page, the annotation went from
 * 139 x 15 pt to 252 x 71 pt: about seven times the area, and 25 mm tall rather than 5.
 *
 * It is laid out with flex rather than the grid used elsewhere on the page for one
 * reason: WeasyPrint's flex support is the more complete of the two, and STACK.md §8's
 * tripwire has to stay a renderer swap.
 */
.cta {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 5px;
  padding: 5px 6px;
  border: 1.25px solid ${brand.accent};
  background: #FFFFFF;
  color: ${brand.accent} !important;
  text-decoration: none;
  /* A link split across a page break loses half its tap target and half its symbol. */
  break-inside: avoid;
}
/*
 * 22 mm, and the size is arithmetic rather than taste.
 *
 * A 43-character base64url secret on a real hostname is about 76 characters, which at
 * error-correction level M encodes to a version-5 symbol: 37 modules, 45 with the quiet
 * zone. At 22 mm that is a 0.49 mm module. The working floor for a phone camera reading a
 * printed page at arm's length is around 0.4 mm, so 19 mm (0.42 mm) would have scanned on
 * a good day and not on a photocopy — and these reports are printed and written on by
 * hand. The cost is 3 mm per nonconformity down the document, which is the right trade.
 *
 * Scanned off a screen this is comfortable either way; it is the paper case that sets it.
 */
.cta-qr {
  flex: 0 0 auto;
  width: 22mm;
  height: 22mm;
  /*
   * Ink, not the accent the rest of the block inherits. A scanner binarises a grayscale
   * conversion, and the accent red lands at about 31% luminance against the quiet zone's
   * white — readable, but ink is near-black and leaves the margin where it costs nothing.
   * The border and the label stay accent, so the block still reads as the one structural
   * use of that colour. The path picks this up through currentColor.
   */
  color: ${brand.ink};
}
.cta-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.cta-label {
  font-size: 7.5pt;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.cta-hint {
  font-size: 6.5pt;
  font-weight: 400;
  color: ${brand.inkSoft};
}
/*
 * The address, printed so a reader whose viewer drops the annotation can still reach it.
 * break-all because a base64url secret contains no spaces: without it the line runs
 * past the card and is clipped, which is the failure this whole block exists to remove.
 *
 * Set in the page's own family rather than a monospace one. Monospace would read better
 * if anyone were going to transcribe it, and nobody transcribes 43 random characters —
 * this line is here to be selected and copied, and the note at the head of this file about
 * not introducing a second typeface still applies.
 */
.cta-url {
  margin-top: 2px;
  font-size: 6pt;
  line-height: 1.25;
  color: ${brand.inkSoft};
  word-break: break-all;
  overflow-wrap: anywhere;
}
.redacted {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 42mm;
  border: 1px dashed ${brand.hairline};
  background: ${brand.panel};
  color: ${brand.inkSoft};
  font-size: 8pt;
}

/* --------------------------------------------------------------------------- notes */
.footnote {
  font-size: 7pt;
  color: ${brand.inkSoft};
  margin-top: 5px;
  font-style: italic;
}
/* The one callout this page allows itself, and only when there is something to read:
   an accent rail, not a filled panel, so it stays legible in mono photocopies too. */
.zone-remark {
  border-left: 3px solid ${brand.accent};
  background: ${brand.panel};
  padding: 5px 8px;
  margin-top: 6px;
  font-size: 8.5pt;
}
.closure-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 0;
  margin-top: 6px;
  border: 1px solid ${brand.hairline};
  border-bottom: none;
  border-right: none;
}
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.avoid-break { break-inside: avoid; }
.page-break { break-before: page; }

${bandRules}
${responseRules}
`;
}
