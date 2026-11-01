import { describe, expect, it } from 'vitest';
import { contrastRatio, RATING_BANDS } from '@audit5s/domain';
import css from '../../../../docs/design/ledger-tokens.css?raw';
import { bandFill, bandInk, bandOf, bandTint, ledger, type Palette } from './ledger';

/** The declarations inside the first block whose selector starts with `selector`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim().toUpperCase()]),
  );
}

const lightCss = block(':root{');
const darkCss = block(':root[data-theme="dark"]');
const systemDarkCss = block(':root:not([data-theme="light"])');
const camel = (name: string) => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

describe('Ledger score bands', () => {
  it('keep the light band values of packages/domain RATING_BANDS, in ledger.ts and ledger-tokens.css', () => {
    for (const band of RATING_BANDS) {
      const name = band.token; // band-outstanding …
      const key = camel(name.slice('band-'.length)) as 'outstanding' | 'onTrack' | 'improving' | 'needsSupport';
      expect(ledger.light[key], name).toBe(band.color);
      expect(ledger.light[`${key}Tint`], `${name}-tint`).toBe(band.tint);
      expect(lightCss[name], name).toBe(band.color);
      expect(lightCss[`${name}-tint`], `${name}-tint`).toBe(band.tint);
    }
  });

  it('maps a score to one of four bands, with N/A never a band', () => {
    expect(bandOf(100)).toBe('outstanding');
    expect(bandOf(90)).toBe('outstanding');
    expect(bandOf(89.9)).toBe('on-track');
    expect(bandOf(75)).toBe('on-track');
    expect(bandOf(74.9)).toBe('improving');
    expect(bandOf(60)).toBe('improving');
    expect(bandOf(59.9)).toBe('needs-support');
    expect(bandOf(0)).toBe('needs-support');
    expect(bandOf(null)).toBe('none');
  });

  it('draws a status tone in its band colour', () => {
    const p = ledger.light;
    expect(bandFill('ok', p)).toBe(p.outstanding);
    expect(bandInk('warn', p)).toBe(p.improving);
    expect(bandTint('crit', p)).toBe(p.needsSupportTint);
    expect(bandFill('on-track', p)).toBe(p.onTrack);
    expect(bandInk('none', p)).toBe(p.muted);
  });
});

describe('Ledger dark palette', () => {
  it('is the same in ledger.ts, the data-theme block and the system-dark block', () => {
    expect(systemDarkCss).toEqual(darkCss);
    for (const [name, value] of Object.entries(darkCss)) {
      if (name.startsWith('shadow')) continue;
      expect(ledger.dark[camel(name.replace(/^band-/, '')) as keyof Palette], name).toBe(value);
    }
  });

  it('reaches 4.5:1 for every text pair and 3:1 for every bar', () => {
    const d = ledger.dark;
    const text: [string, string, string][] = [
      ...(['ink', 'ink2', 'muted'] as const).flatMap((ink) =>
        (['ground', 'surface', 'chip'] as const).map((g): [string, string, string] => [`${ink}/${g}`, d[ink], d[g]]),
      ),
      ['primaryInk/ground', d.primaryInk, d.ground],
      ['primaryInk/surface', d.primaryInk, d.surface],
      ['onPrimary/primary', d.onPrimary, d.primary],
      ['onSecondary/secondary', d.onSecondary, d.secondary],
      ['onSecondarySoft/secondarySoft', d.onSecondarySoft, d.secondarySoft],
      ['onInk/ink', d.onInk, d.ink],
    ];
    const bars: [string, string, string][] = [['focus/surface', d.focus, d.surface]];
    for (const key of ['outstanding', 'onTrack', 'improving', 'needsSupport'] as const) {
      text.push([`${key}/tint`, d[key], d[`${key}Tint`]], [`${key}/surface`, d[key], d.surface]);
      bars.push([`${key} bar/surface`, d[key], d.surface], [`${key} bar/ground`, d[key], d.ground]);
    }
    for (const [pair, fg, bg] of text) expect(contrastRatio(fg, bg), pair).toBeGreaterThanOrEqual(4.5);
    for (const [pair, fg, bg] of bars) expect(contrastRatio(fg, bg), pair).toBeGreaterThanOrEqual(3);
  });
});
