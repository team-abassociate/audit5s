import { describe, expect, it } from 'vitest';
import {
  S_SECTION_LABELS,
  S_SECTION_ORDER,
  responseMarks,
  sectionLabel,
} from './sections';

describe('section labels', () => {
  it('matches the workbook and report strings exactly, en dash included', () => {
    expect(sectionLabel('S1_SORT')).toBe('1S – SEIRI (SORT)');
    expect(sectionLabel('S2_SET_IN_ORDER')).toBe('2S – SEITON (SET IN ORDER)');
    expect(sectionLabel('S3_SHINE')).toBe('3S – SEISO (SHINE)');
    expect(sectionLabel('S4_STANDARDIZE')).toBe('4S – SEIKETSU (STANDARDIZE)');
    expect(sectionLabel('S5_SUSTAIN')).toBe('5S – SHITSUKE (SUSTAIN)');
    expect(sectionLabel('SAFETY')).not.toMatch(/6S/);
  });

  it('covers every section in workbook order', () => {
    expect(S_SECTION_ORDER).toHaveLength(6);
    expect(S_SECTION_ORDER.at(-1)).toBe('SAFETY');
    for (const section of S_SECTION_ORDER) {
      expect(S_SECTION_LABELS[section]).toBeTruthy();
    }
  });
});

describe('responseMarks', () => {
  it('returns null for NA so it can be excluded from the denominator', () => {
    expect(responseMarks('SCORE_2')).toBe(2);
    expect(responseMarks('SCORE_1')).toBe(1);
    expect(responseMarks('SCORE_0')).toBe(0);
    expect(responseMarks('NA')).toBeNull();
  });
});
