import { describe, expect, it } from 'vitest';
import { isChecklistSheet, parseChecklistSheet, validateChecklistSheet } from '@audit5s/domain';
import { TEMPLATE_SHEET_NAME, templateRows, xlsx } from './template';

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

  it('is a zip container, which is what the importer checks first', () => {
    expect([...xlsx(TEMPLATE_SHEET_NAME, templateRows()).subarray(0, 4)]).toEqual([
      0x50, 0x4b, 0x03, 0x04,
    ]);
  });
});
