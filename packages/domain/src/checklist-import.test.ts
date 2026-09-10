import { describe, expect, it } from 'vitest';
import {
  CHECKLIST_SHEET_TITLE_PATTERN,
  canonicalChecklistSignature,
  diffChecklistQuestions,
  isChecklistSheet,
  normalizeQuestionText,
  parseChecklistSheet,
  sectionForHeaderRow,
  templateCodeForSheet,
  validateChecklistSheet,
  type CellValue,
  type SheetGrid,
} from './checklist-import';
import { S_SECTION_ORDER } from './sections';

const SECTION_HEADERS = [
  '1S – SEIRI (SORT)',
  '2S – SEITON (SET IN ORDER)',
  '3S – SEISO (SHINE)',
  '4S – SEIKETSU (STANDARDIZE)',
  '5S – SHITSUKE (SUSTAIN)',
];

/**
 * A sheet shaped exactly like the real workbook (HANDOFF.md §3.4): title, four metadata
 * rows, a header row, then five blocks of ten separated by section headers and closed by
 * a sub-total, followed by the totals block and the signature line.
 */
function buildSheet(
  name: string,
  options: {
    questionsPerSection?: number[];
    text?: (section: number, position: number, sr: number) => string;
    sr?: (sr: number) => CellValue;
    dropSection?: number;
  } = {},
): SheetGrid {
  const counts = options.questionsPerSection ?? [10, 10, 10, 10, 10];
  const text =
    options.text ?? ((section, position) => `Section ${section} question ${position}`);
  const rows: CellValue[][] = [
    [`5S AUDIT CHECK SHEET – ${name.toUpperCase()}`, null, null, null, null],
    ['Company:', null, 'Audit Date:', null, 'Scoring: Yes = 2 marks, No = 0 marks.'],
    ['Area / Dept.:', name, 'Auditor Name:', null, null],
    ['Shift:', null, 'Auditee / Area Owner:', null, null],
    [null, null, null, null, null],
    ['Sr.', 'Check Point', 'Yes / No', 'Marks', 'Remarks / Observations'],
  ];

  let sr = 0;
  for (let section = 1; section <= 5; section += 1) {
    if (options.dropSection === section) continue;
    rows.push([SECTION_HEADERS[section - 1]!, null, null, null, null]);
    for (let position = 1; position <= (counts[section - 1] ?? 10); position += 1) {
      sr += 1;
      rows.push([options.sr ? options.sr(sr) : sr, text(section, position, sr), null, 0, null]);
    }
    rows.push([`Sub-total ${section}S (out of 20)`, null, null, 0, null]);
  }

  rows.push(['TOTAL SCORE (out of 100)', null, null, 0, null]);
  rows.push(['PERCENTAGE', null, null, 0, null]);
  rows.push(['RATING', null, null, 'Needs Support', null]);
  rows.push([null, null, null, null, null]);
  rows.push([null, 'Auditor Signature: ______________________', null, null, null]);
  rows.push(['Prepared by AB Associates, Nashik.', null, null, null, null]);

  return { name, index: 0, rows };
}

describe('recognising a checklist sheet', () => {
  it('accepts the workbook title with any dash', () => {
    for (const dash of ['–', '—', '-']) {
      expect(CHECKLIST_SHEET_TITLE_PATTERN.test(`5S AUDIT CHECK SHEET ${dash} PREMISES`)).toBe(true);
    }
  });

  it('rejects the three legacy planning sheets (Q7)', () => {
    for (const title of [
      '5S AUDIT TEAM & STEERING COMMITTEE',
      'ANNUAL 5S AUDIT SCHEDULE – 50 ZONES',
      'MONTHLY ZONE-WISE 5S SCORE RECORD – 50 ZONES',
    ]) {
      expect(isChecklistSheet({ name: 'x', index: 0, rows: [[title]] })).toBe(false);
    }
  });
});

describe('section headers', () => {
  it('maps each header row to its section, dash-insensitively', () => {
    expect(SECTION_HEADERS.map((header) => sectionForHeaderRow(header))).toEqual([
      ...S_SECTION_ORDER,
    ]);
    expect(sectionForHeaderRow('3S - SEISO (SHINE)')).toBe('S3_SHINE');
    expect(sectionForHeaderRow('3S—SEISO')).toBe('S3_SHINE');
  });

  it('is not fooled by a sub-total or a totals row', () => {
    expect(sectionForHeaderRow('Sub-total 1S (out of 20)')).toBeNull();
    expect(sectionForHeaderRow('TOTAL SCORE (out of 100)')).toBeNull();
  });
});

describe('template codes', () => {
  it('derives the nine codes of HANDOFF.md §3.2 from the sheet names', () => {
    expect(
      [
        'Shop Floor',
        'Office',
        'Stores (RM)',
        'Production',
        'FG Stores',
        'Packing Area',
        'Boiler & Utility',
        'Maintenance',
        'Premises',
      ].map(templateCodeForSheet),
    ).toEqual([
      'SHOP_FLOOR',
      'OFFICE',
      'STORES_RM',
      'PRODUCTION',
      'FG_STORES',
      'PACKING_AREA',
      'BOILER_UTILITY',
      'MAINTENANCE',
      'PREMISES',
    ]);
  });
});

describe('normalisation', () => {
  it('reports what it changed, and changes it', () => {
    const result = normalizeQuestionText('  Tools are “put back”   after   use.\n');
    expect(result.text).toBe('Tools are "put back" after use.');
    expect(result.notes).toEqual([
      'leading or trailing whitespace removed',
      'internal whitespace collapsed to single spaces',
      'curly quotes replaced with straight quotes',
    ]);
  });

  it('leaves already-clean text alone and silent', () => {
    expect(normalizeQuestionText('Tools are put back after use.')).toEqual({
      text: 'Tools are put back after use.',
      notes: [],
    });
  });
});

describe('parsing the sheet-per-department profile', () => {
  const parsed = parseChecklistSheet(buildSheet('Premises'));

  it('reads exactly the 50 question rows', () => {
    expect(parsed.questions).toHaveLength(50);
    expect(parsed.questions[0]?.globalOrder).toBe(1);
    expect(parsed.questions[49]?.globalOrder).toBe(50);
  });

  it('assigns section and position from the headers, not from row numbers', () => {
    expect(parsed.questions[0]?.section).toBe('S1_SORT');
    expect(parsed.questions[0]?.orderInSection).toBe(1);
    expect(parsed.questions[10]?.section).toBe('S2_SET_IN_ORDER');
    expect(parsed.questions[10]?.orderInSection).toBe(1);
    expect(parsed.questions[49]?.section).toBe('S5_SUSTAIN');
    expect(parsed.questions[49]?.orderInSection).toBe(10);
  });

  it('survives inserted rows, because sections are found by regex', () => {
    const shifted = buildSheet('Premises');
    shifted.rows.splice(6, 0, ['A note somebody added', null, null, null, null]);
    const reparsed = parseChecklistSheet(shifted);
    expect(reparsed.questions.map((q) => q.text)).toEqual(parsed.questions.map((q) => q.text));
  });

  it('skips sub-totals, the totals block and the signature line', () => {
    expect(parsed.questions.some((question) => /Sub-total|TOTAL SCORE|Signature/.test(question.text))).toBe(
      false,
    );
    expect(parsed.skippedRowCount).toBeGreaterThan(0);
  });

  it('never reads the legacy Yes/No or Marks columns', () => {
    // Column D carries a 0 on every question row in the real file. If it were read, the
    // scale would silently become the sheet's legacy Yes=2/No=0 rather than D3's 2/1/0/NA.
    expect(JSON.stringify(parsed.questions)).not.toContain('"Marks"');
    for (const question of parsed.questions) {
      expect(Object.keys(question.raw)).toEqual(['sr', 'checkPoint']);
    }
  });
});

describe('validation (§8.5 stage 3, CQ-1)', () => {
  it('passes a well-formed sheet with no messages at all', () => {
    const validated = validateChecklistSheet(parseChecklistSheet(buildSheet('Premises')));
    expect(validated.severity).toBe('OK');
    expect(validated.messages).toEqual([]);
    expect(validated.questions).toHaveLength(50);
  });

  it('rejects a missing section', () => {
    const validated = validateChecklistSheet(
      parseChecklistSheet(buildSheet('Premises', { dropSection: 3 })),
    );
    expect(validated.severity).toBe('ERROR');
    expect(validated.messages).toContain('Section S3_SHINE is missing from this sheet');
    expect(validated.questions).toEqual([]);
  });

  it('rejects 9 questions in a section', () => {
    const validated = validateChecklistSheet(
      parseChecklistSheet(buildSheet('Premises', { questionsPerSection: [9, 10, 10, 10, 10] })),
    );
    expect(validated.severity).toBe('ERROR');
    expect(validated.messages).toContain(
      'Section S1_SORT has 9 questions; exactly 10 are required',
    );
  });

  it('rejects 11 questions in a section', () => {
    const validated = validateChecklistSheet(
      parseChecklistSheet(buildSheet('Premises', { questionsPerSection: [11, 10, 10, 10, 10] })),
    );
    expect(validated.severity).toBe('ERROR');
    expect(validated.messages).toContain(
      'Section S1_SORT has 11 questions; exactly 10 are required',
    );
  });

  it('rejects a Sr. sequence with a gap', () => {
    const validated = validateChecklistSheet(
      parseChecklistSheet(buildSheet('Premises', { sr: (sr) => (sr >= 20 ? sr + 1 : sr) })),
    );
    expect(validated.severity).toBe('ERROR');
    expect(validated.rows.find((row) => row.globalOrder === 21)?.messages.join(' ')).toContain(
      'expected 20',
    );
  });

  it('warns, but does not reject, on a duplicate Check Point inside a section', () => {
    const validated = validateChecklistSheet(
      parseChecklistSheet(
        buildSheet('Premises', {
          text: (section, position) => `Section ${section} question ${position === 2 ? 1 : position}`,
        }),
      ),
    );
    expect(validated.severity).toBe('WARNING');
    expect(validated.questions).toHaveLength(50);
    const duplicated = validated.rows.filter((row) =>
      row.messages.includes('Duplicate Check Point within this section'),
    );
    expect(duplicated).toHaveLength(5);
  });

  it('warns on a Check Point repeated across sections', () => {
    const validated = validateChecklistSheet(
      parseChecklistSheet(buildSheet('Premises', { text: (_s, position) => `Question ${position}` })),
    );
    expect(validated.severity).toBe('WARNING');
    expect(
      validated.rows.filter((row) =>
        row.messages.includes('This Check Point also appears in another section'),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rejects a Check Point over 500 characters', () => {
    const validated = validateChecklistSheet(
      parseChecklistSheet(
        buildSheet('Premises', { text: (s, p) => (s === 1 && p === 1 ? 'x'.repeat(501) : `Q ${s}.${p}`) }),
      ),
    );
    expect(validated.severity).toBe('ERROR');
    expect(validated.rows[0]?.messages.join(' ')).toContain('the limit is 500');
  });
});

describe('content signature (§8.5 stage 4)', () => {
  const questions = validateChecklistSheet(parseChecklistSheet(buildSheet('Premises'))).questions;

  it('is stable across a re-read of the same file', () => {
    const again = validateChecklistSheet(parseChecklistSheet(buildSheet('Premises'))).questions;
    expect(canonicalChecklistSignature(again)).toBe(canonicalChecklistSignature(questions));
  });

  it('ignores the order rows were read in', () => {
    expect(canonicalChecklistSignature([...questions].reverse())).toBe(
      canonicalChecklistSignature(questions),
    );
  });

  it('changes when a single word does', () => {
    const edited = questions.map((question, index) =>
      index === 7 ? { ...question, text: `${question.text} (revised)` } : question,
    );
    expect(canonicalChecklistSignature(edited)).not.toBe(canonicalChecklistSignature(questions));
  });
});

describe('the preview diff (§8.5 stage 5)', () => {
  const current = validateChecklistSheet(parseChecklistSheet(buildSheet('Premises'))).questions;

  it('reports every question unchanged against itself', () => {
    const entries = diffChecklistQuestions(current, current);
    expect(entries).toHaveLength(50);
    expect(entries.every((entry) => entry.change === 'UNCHANGED')).toBe(true);
  });

  it('reports a reworded question as CHANGED, not as a remove plus an add', () => {
    const incoming = current.map((question, index) =>
      index === 3 ? { ...question, text: 'Reworded question' } : question,
    );
    const changed = diffChecklistQuestions(current, incoming).filter(
      (entry) => entry.change !== 'UNCHANGED',
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      change: 'CHANGED',
      section: 'S1_SORT',
      orderInSection: 4,
      currentText: current[3]?.text,
      incomingText: 'Reworded question',
    });
  });

  it('reports a first import as 50 additions', () => {
    const entries = diffChecklistQuestions([], current);
    expect(entries.filter((entry) => entry.change === 'ADDED')).toHaveLength(50);
  });
});
