import { describe, expect, it } from 'vitest';
import { renderReportHtml } from './index';
import {
  FIXTURE_IMAGE_DATA_URI,
  fixtureAfterEvidencePayload,
  fixtureSummaryPayload,
  fixtureZonePayload,
} from './fixture';

/**
 * The layout rules of HANDOFF.md §4.1–§4.3, asserted against the rendered HTML.
 *
 * These run without a browser on purpose. Every rule the row names — GOOD side by side, a
 * nonconformity's right half empty and textless, the after-evidence right half populated
 * for both options, GOOD photos unchanged between v1 and v2 — is a property of the markup,
 * not of the PDF. Testing them here means they are checked on every commit rather than
 * only where a Chromium happens to be installed, and it means a failure names the rule
 * rather than a byte offset.
 */

const resolve = () => FIXTURE_IMAGE_DATA_URI;

/** The markup of one section, between its heading and the next. */
function sectionOf(html: string, title: string): string {
  const start = html.indexOf(`>${title}</h2>`);
  expect(start, `section "${title}" is missing`).toBeGreaterThan(-1);
  const next = html.indexOf('class="section-title"', start + 1);
  return html.slice(start, next === -1 ? html.length : next);
}

describe('§4.1 — the initial Zone report', () => {
  const html = renderReportHtml(fixtureZonePayload(), resolve);

  it('carries the header band, the subtitle and the AB Associates card (§3.5)', () => {
    expect(html).toContain('LEAN 5S — ZONE REPORT');
    expect(html).toContain('Zone-wise assessment');
    expect(html).toContain('AB Associates');
    expect(html).toContain('Lean 5S Report • AB Associates');
  });

  it('renders the 3 × 3 metadata grid, with the Zone as "Zone {code} — {name}"', () => {
    for (const label of [
      'Company / Unit',
      'Department',
      'Zone',
      'Audit date',
      'Auditor name',
      'Zone leader',
      'Marks',
      'Percentage',
      'Rating',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Zone 1 — Press');
    // A6: one decimal for a percentage, `achieved / max` integers for marks.
    expect(html).toContain('82.5%');
    expect(html).toContain('66 / 80');
    expect(html).toContain('On Track');
  });

  it('prints a fully-NA section as N/A rather than 0% (D4)', () => {
    const table = sectionOf(html, 'S-wise scoring');
    // The cell reads N/A and carries the neutral class, not a band: `bandFor(null)` is
    // null precisely so a fully-NA section cannot fall through to "Needs Support".
    expect(table).toContain('<td class="num na">N/A</td>');
    // `>0.0%<` rather than `0.0%`: the latter is a substring of "80.0%" and would pass
    // against a table that did print a zero percentage.
    expect(table).not.toContain('>0.0%<');
  });

  it('draws the radar as inline SVG with achieved/max under each axis, no chart library', () => {
    const web = sectionOf(html, '5S performance web');
    expect(web).toContain('<svg');
    expect(web).toContain('<polygon');
    expect(web).toContain('15/20');
    expect(web).toContain(
      'Each S shows achieved marks / applicable maximum; polygon uses percentage.',
    );
    // STACK.md §5: nothing about the layout may depend on JavaScript.
    expect(html).not.toContain('<script');
  });

  it('puts the auditor selfie in the AUDITOR VERIFICATION box', () => {
    expect(sectionOf(html, 'Auditor verification')).toContain('class="selfie"');
  });

  it('renders the four rating pills at 90 / 75 / 60 (R-6b)', () => {
    expect(html).toContain('≥ 90% Outstanding');
    expect(html).toContain('75–89% On Track');
    expect(html).toContain('60–74% Improving');
    expect(html).toContain('&lt; 60% Needs Support');
  });

  it('opens each checklist section with an ink header row carrying its subtotal', () => {
    const table = sectionOf(html, 'Checklist — responses and marks');
    expect(table).toContain('class="section-row"');
    expect(table).toContain('1S – SEIRI (SORT)');
    expect(table).toContain('15 / 20');
    // The per-question remark, as a second smaller line under the question text.
    expect(table).toContain('class="q-remark"');
    expect(table).toContain('Spillage under the press');
    expect(table).toContain('Well implemented');
    expect(table).toContain('Needs improvement');
  });

  it('closes with the ZONE TOTAL row and the NA footnote', () => {
    expect(html).toContain('Zone total');
    expect(html).toContain('NA is excluded from the applicable maximum.');
    expect(html).toContain(
      'After-improvement evidence is managed separately and does not change these marks.',
    );
  });

  it('lays GOOD photos two per row, side by side', () => {
    const good = sectionOf(html, 'Good evidence');
    expect(good).toContain('class="good-grid"');
    expect((good.match(/class="photo-card"/g) ?? []).length).toBe(2);
    expect(good).toContain('Q7 · 1S · Score 2');
    expect(good).toContain('Shadow board complete');
  });

  /**
   * §10.3-A, stated twice in the sources because it is the rule most likely to be
   * "improved" by adding a helpful label: the right half is reserved for the after-photo
   * and carries **no text whatsoever**.
   */
  it('leaves a nonconformity’s right half an empty, textless placeholder', () => {
    const section = sectionOf(html, 'Nonconformities');
    expect(section).toContain('class="nc-row"');

    const placeholders = section.match(/<div class="nc-placeholder"[^>]*>(.*?)<\/div>/g) ?? [];
    expect(placeholders.length).toBe(3);
    for (const placeholder of placeholders) {
      expect(placeholder).toBe('<div class="nc-placeholder"></div>');
    }
    // No outcome markup at all on an initial report, for any of the three items.
    expect(section).not.toContain('nc-answer');
    expect(section).not.toContain('PENDING');
    expect(section).not.toContain('AFTER PHOTO');
  });

  it('gives each nonconformity the warning badge and the corrective-action button', () => {
    const section = sectionOf(html, 'Nonconformities');
    expect((section.match(/class="badge-nc"/g) ?? []).length).toBe(3);
    expect(section).toContain('View / Submit Corrective Action');
    expect(section).toContain('https://app.example.test/ca/FIXED-TOKEN-ONE');
    expect(section).toContain('Q1 · 1S · Score 0');
  });

  it('renders a redacted photo as the placeholder with "Photo removed" (R-5)', () => {
    const section = sectionOf(html, 'Nonconformities');
    expect(section).toContain('Photo removed');
    // The caption and the remark survive: the record says a photo was present and removed.
    expect(section).toContain('Coolant leak at the sump');
    expect(section).toContain('Q21 · 3S · Score 0');
  });
});

describe('§4.2 — the after-evidence report', () => {
  const v1 = renderReportHtml(fixtureZonePayload(), resolve);
  const v2 = renderReportHtml(fixtureAfterEvidencePayload(), resolve);

  /**
   * The row's own words: "GOOD photos unchanged between v1 and v2". The good work is part
   * of the record, not a placeholder to be replaced.
   */
  it('leaves the GOOD evidence block byte-identical to version 1', () => {
    expect(sectionOf(v2, 'Good evidence')).toBe(sectionOf(v1, 'Good evidence'));
  });

  it('leaves the checklist and the S-wise scoring identical too', () => {
    expect(sectionOf(v2, 'S-wise scoring')).toBe(sectionOf(v1, 'S-wise scoring'));
    expect(sectionOf(v2, 'Checklist — responses and marks')).toBe(
      sectionOf(v1, 'Checklist — responses and marks'),
    );
  });

  it('fills the right half for Option A — after photo, submitter, description, ✓ Verified', () => {
    const section = sectionOf(v2, 'Nonconformities');
    expect(section).toContain('class="nc-answer"');
    expect(section).toContain('AFTER PHOTO');
    expect(section).toContain('Submitted by R. Deshmukh');
    expect(section).toContain('Spillage cleared and a drip tray fitted.');
    expect(section).toContain('✓ VERIFIED');
  });

  it('fills the right half for Option B — NOT POSSIBLE and the explanation', () => {
    const section = sectionOf(v2, 'Nonconformities');
    expect(section).toContain('NOT POSSIBLE');
    expect(section).toContain('Requires vendor approval; PO raised 12 Sep.');
  });

  it('shows an item still open as Pending, with its deadline', () => {
    const section = sectionOf(v2, 'Nonconformities');
    expect(section).toContain('PENDING');
    expect(section).toContain('Due 11 Mar 2026');
  });

  it('adds the closure-summary block (§10.3-B)', () => {
    const closure = sectionOf(v2, 'Closure summary');
    expect(closure).toContain('Nonconformities');
    expect(closure).toContain('Closure rate');
    expect(closure).toContain('66.7%');
  });

  it('never leaves an empty placeholder once the outcomes are known', () => {
    expect(sectionOf(v2, 'Nonconformities')).not.toContain('nc-placeholder');
  });
});

describe('§4.3 — the multi-Zone summary', () => {
  const html = renderReportHtml(fixtureSummaryPayload(), resolve);

  it('sums achieved over summed max — never an average of Zone percentages (§10.3-C)', () => {
    // Zone 1 scores 66/80 (82.5%), Zone 2 scores 40/80 (50.0%).
    // Σachieved / Σmax = 106 / 160 = 66.3%. The *average* of the two percentages is
    // 66.25% → also 66.3% at one decimal, so the percentage alone cannot tell the rules
    // apart. The summed marks can, and the per-S row is where they differ outright:
    // 1S is 15/20 + 10/20 = 25/40, which an average would never produce.
    expect(html).toContain('106 / 160');
    expect(html).toContain('66.3%');
    expect(sectionOf(html, 'S-wise scoring')).toContain('25');
    expect(sectionOf(html, 'Zone-wise marks per S')).toContain('25/40');
  });

  it('carries its own header and subtitle', () => {
    expect(html).toContain('LEAN 5S SUMMARY REPORT');
    expect(html).toContain('Cumulative performance across the selected zones');
    expect(html).toContain('Zones summarised');
  });

  it('has NO auditor selfie (§4.3 item 9)', () => {
    expect(html).not.toContain('Auditor verification');
    expect(html).not.toContain('class="selfie"');
  });

  it('renders the zone-wise matrix with each S cell tinted by its own band', () => {
    const table = sectionOf(html, 'Zone-wise marks per S');
    expect(table).toContain('All selected zones');
    expect(table).toContain('2 zone(s)');
    expect(table).toContain('tint-band-');
  });

  it('renders the comparison bars as inline SVG, one per Zone, in zone order', () => {
    const bars = sectionOf(html, 'Zone score comparison');
    expect(bars).toContain('<svg');
    expect(bars).toContain('1 — Press');
    expect(bars).toContain('2 — Assembly');
    expect(bars.indexOf('1 — Press')).toBeLessThan(bars.indexOf('2 — Assembly'));
  });

  it('carries the rating-scale footnote verbatim', () => {
    expect(html).toContain('Cell colours follow the rating scale: green ≥ 90% Outstanding');
    expect(html).toContain('NA answers are excluded from the applicable maximum.');
  });

  it('adds the §10.3-C blocks: rankings, histogram, recurrence, flagged photos', () => {
    expect(html).toContain('Highest performing');
    expect(html).toContain('Lowest performing');
    expect(html).toContain('Weakest: 1S');
    expect(html).toContain('Score band distribution');
    expect(html).toContain('Recurrent check point');
    expect(html).toContain('Flagged photographs');
  });

  it('shows only the flagged photographs, not every photo in the Zone', () => {
    const flagged = sectionOf(html, 'Flagged photographs');
    // Zone 1 flagged one GOOD and one NONCONFORMITY; Zone 2 flagged one GOOD only.
    expect((flagged.match(/class="photo-card"/g) ?? []).length).toBe(3);
  });
});

describe('the renderer refuses a payload it has no layout for (§10.5)', () => {
  it('throws rather than rendering half a document', () => {
    const future = { ...fixtureZonePayload(), schemaVersion: 99 } as never;
    expect(() => renderReportHtml(future, resolve)).toThrow(/schema version 99/);
  });
});
