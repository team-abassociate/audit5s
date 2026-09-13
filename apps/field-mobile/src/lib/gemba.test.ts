import { describe, expect, it } from 'vitest';
import { gemba, ratingColor } from './gemba';

describe('Gemba score colours', () => {
  it('maps every domain rating into the three visual status bands in both themes', () => {
    for (const palette of [gemba.light, gemba.dark]) {
      expect(ratingColor('band-outstanding', palette)).toBe(palette.ok);
      expect(ratingColor('band-on-track', palette)).toBe(palette.ok);
      expect(ratingColor('band-improving', palette)).toBe(palette.warn);
      expect(ratingColor('band-needs-support', palette)).toBe(palette.crit);
    }
  });
});
