import { describe, expect, it } from 'vitest';
import { contrastRatio, formatKaizenRatio, formatYearMonth, textOn } from './kaizen-display';

describe('Kaizen display', () => {
  it('labels months the en-IN way and ratios truncated, never rounded up', () => {
    expect(formatYearMonth('2026-09')).toBe('Sept 26');
    expect(formatYearMonth('2027-01')).toBe('Jan 27');
    expect(formatKaizenRatio(57.149)).toBe('57.1%');
    expect(formatKaizenRatio(99.99)).toBe('99.9%');
    expect(formatKaizenRatio(null)).toBe('—');
  });

  it('picks the readable one of ink and tile', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
    expect(textOn('#1D1B16', '#1D1B16', '#FCFBF7')).toBe('#FCFBF7');
    expect(textOn('#CFC9B8', '#1D1B16', '#FCFBF7')).toBe('#1D1B16');
  });
});
