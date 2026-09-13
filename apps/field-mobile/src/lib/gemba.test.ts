import { describe, expect, it } from 'vitest';
import { bandFill, bandInk, bandOf, gemba } from './gemba';

describe('Gemba score bands', () => {
  it('maps the domain rating scale into three colour bands, with N/A never a band', () => {
    expect(bandOf(100)).toBe('ok');
    expect(bandOf(75)).toBe('ok');
    expect(bandOf(74.9)).toBe('warn');
    expect(bandOf(60)).toBe('warn');
    expect(bandOf(59.9)).toBe('crit');
    expect(bandOf(0)).toBe('crit');
    expect(bandOf(null)).toBe('none');
  });

  it('resolves every band to a token in both themes', () => {
    for (const palette of [gemba.light, gemba.dark]) {
      expect(bandFill('ok', palette)).toBe(palette.okBand);
      expect(bandFill('warn', palette)).toBe(palette.warnBand);
      expect(bandFill('crit', palette)).toBe(palette.critBand);
      expect(bandFill('none', palette)).toBe(palette.edgeSoft);
      expect(bandInk('ok', palette)).toBe(palette.ok);
      expect(bandInk('crit', palette)).toBe(palette.crit);
      expect(bandInk('none', palette)).toBe(palette.ink3);
    }
  });
});
