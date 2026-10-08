import { describe, expect, it } from 'vitest';
import { gemba } from './gemba';
import { contrast, monthLabel, ratio, textOn } from './kaizen-chart-math';

describe('Kaizen chart rules', () => {
  it('label months the en-IN way and ratios truncated, never rounded up', () => {
    expect(monthLabel('2026-09')).toBe('Sept 26');
    expect(monthLabel('2027-01')).toBe('Jan 27');
    expect(ratio(57.149)).toBe('57.1%');
    expect(ratio(99.99)).toBe('99.9%');
    expect(ratio(null)).toBe('—');
  });

  it("put a readable count on every funnel stage, in both themes (dark mode's green is light)", () => {
    for (const palette of [gemba.light, gemba.dark]) {
      for (const fill of [palette.edgeSoft, palette.ink3, palette.okBand, palette.ok]) {
        const ink = textOn(fill, palette.ink, palette.tile);
        // The count is the only text on a fill: 20 px Archivo 900, large text, so 3:1. The
        // stage name and share sit beneath in ink on the tile, because light --ok-band holds
        // neither ink nor tile at 4.5:1 (4.24 at best) — this keeps it honest if a token moves.
        expect(contrast(fill, ink), fill).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(palette.tile, palette.ink)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.tile, palette.ink2)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
