import { describe, expect, it } from 'vitest';
import { isChecklistSheet, parseChecklistSheet, validateChecklistSheet } from '@audit5s/domain';
import { TEMPLATE_SHEET_NAME, checkDraft, templateRows, xlsx } from './template';

describe('the checklist template', () => {
  it('imports cleanly through the profile once its Check Points are filled in', () => {
    const rows = templateRows().map((row) =>
      typeof row[0] === 'number'
        ? [row[0], `Check point ${row[0]}`, `जाँच बिंदु ${row[0]}`, `तपासणी ${row[0]}`]
        : row,
    );
    const grid = { name: TEMPLATE_SHEET_NAME, index: 0, rows };
    expect(isChecklistSheet(grid)).toBe(true);

    const parsed = parseChecklistSheet(grid);
    expect(parsed.translationColumns).toEqual({ hi: 2, mr: 3 });
    const validated = validateChecklistSheet(parsed);
    expect(validated.messages).toEqual([]);
    expect(validated.severity).toBe('OK');
    expect(parsed.questions).toHaveLength(50);
  });

  it('carries an editor draft into exactly the questions the import would commit', () => {
    const draft = {
      name: 'Paint Shop',
      questions: Array.from({ length: 50 }, (_, i) => ({
        text: ` Check  point\n${i + 1} `,
        hi: i % 2 ? `जाँच ${i + 1}` : '',
        mr: '',
      })),
    };
    const validated = validateChecklistSheet(
      parseChecklistSheet({ name: draft.name, index: 0, rows: templateRows(draft) }),
    );
    expect(validated.severity).toBe('OK');
    expect(validated.parsed.title).toBe('PAINT SHOP');
    expect(validated.questions.map((question) => question.text)).toEqual(
      draft.questions.map((_, i) => `Check point ${i + 1}`),
    );
    expect(validated.questions[1]?.translations).toEqual({ hi: 'जाँच 2' });
    expect(validated.questions[0]?.translations).toEqual({});
    expect(checkDraft(draft)).toEqual({
      name: null,
      errors: Array(50).fill(null),
      warnings: Array(50).fill(null),
    });
  });

  it('names the blank and the duplicate questions, and only those', () => {
    const questions = Array.from({ length: 50 }, (_, i) => ({ text: `Q${i + 1}`, hi: '', mr: '' }));
    questions[2] = { text: '  ', hi: '', mr: '' };
    questions[4] = { text: 'Q4', hi: '', mr: 'not devanagari' };
    const check = checkDraft({ name: 'Bad/Name', questions });
    expect(check.name).toMatch(/Leave out/);
    expect(check.errors.filter(Boolean)).toEqual(['Write the question in English']);
    expect(check.errors[2]).toBe('Write the question in English');
    expect(check.warnings[3]).toBe('This Check Point also appears in another section');
    expect(check.warnings[4]).toBe(
      'The Marathi column has no Devanagari text here — is it in the right column? · Duplicate Check Point within this section',
    );
    expect(check.warnings.filter(Boolean)).toHaveLength(2);
  });

  it('is a zip container, which is what the importer checks first', () => {
    expect([...xlsx(TEMPLATE_SHEET_NAME, templateRows()).subarray(0, 4)]).toEqual([
      0x50, 0x4b, 0x03, 0x04,
    ]);
  });
});
