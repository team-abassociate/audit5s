import { describe, expect, it } from 'vitest';
import { ledger } from './ledger';
import { contrastRatio as contrast, textOn } from '@audit5s/domain';

describe('Kaizen funnel colours', () => {
  it("put a readable count on every funnel stage, in both themes (dark mode's green is light)", () => {
    for (const palette of [ledger.light, ledger.dark]) {
      // The fills of `FunnelCard` in components/kaizen-charts.tsx, in order.
      for (const fill of [palette.ruleSoft, palette.muted, palette.outstandingTint, palette.outstanding]) {
        const ink = textOn(fill, palette.ink, palette.surface);
        // The count is the only text on a fill: 20 px Manrope, large text, so 3:1. The stage
        // name and share sit beneath in ink on the surface — this keeps it honest if a token moves.
        expect(contrast(fill, ink), fill).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(palette.surface, palette.ink)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.surface, palette.ink2)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
