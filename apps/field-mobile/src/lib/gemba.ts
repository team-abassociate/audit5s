import { bandFor } from '@audit5s/domain';

/** Generated from docs/design/gemba-tokens.css. Keep the names and values in sync. */
export const gemba = {
  light: {
    board: '#EEEBE1',
    boardLine: 'rgba(29,27,22,0.055)',
    tile: '#FCFBF7',
    tile2: '#F6F3EA',
    ink: '#1D1B16',
    ink2: '#5B5647',
    ink3: '#8A8372',
    edge: '#1D1B16',
    edgeSoft: '#CFC9B8',
    hard: 'rgba(29,27,22,0.22)',
    tape: '#D9CF9A',
    tapeInk: '#33301F',
    slip: '#E8E24B',
    slipInk: '#33301F',
    ok: '#2F6E3A',
    okBand: '#3E8E4B',
    warn: '#7E5C03',
    warnBand: '#D79A05',
    crit: '#AB2F1C',
    critBand: '#B4321F',
    accent: '#0B6E77',
    accentSoft: '#D5E7E8',
  },
  dark: {
    board: '#151816',
    boardLine: 'rgba(255,255,255,0.045)',
    tile: '#1E2220',
    tile2: '#191D1B',
    ink: '#EDEAE0',
    ink2: '#A8A899',
    ink3: '#7B7D71',
    edge: '#3C423D',
    edgeSoft: '#2C312D',
    hard: 'rgba(0,0,0,0.55)',
    tape: '#57512F',
    tapeInk: '#EDE6C4',
    slip: '#D2C92F',
    slipInk: '#33301F',
    ok: '#6FC27E',
    okBand: '#49A05A',
    warn: '#E7B03A',
    warnBand: '#D79A05',
    crit: '#F27458',
    critBand: '#D94A2E',
    accent: '#4FD2D8',
    accentSoft: '#12302F',
  },
} as const;

export const gembaFonts = {
  regular: 'Archivo_400Regular',
  medium: 'Archivo_600SemiBold',
  bold: 'Archivo_800ExtraBold',
  black: 'Archivo_900Black',
  mono: 'DMMono_400Regular',
  monoMedium: 'DMMono_500Medium',
} as const;

type Palette = (typeof gemba)[keyof typeof gemba];

/**
 * Score band → design-system band, the same mapping as admin-web's `lib/bands.ts`.
 *
 * `packages/domain` owns the scale (R-6b: four bands). The design system carries three colour
 * pairs, so the two upper bands share `ok` and the band **label** keeps all four apart.
 * `none` is "nothing applicable" or "not scored" — never a zero.
 */
export type Band = 'ok' | 'warn' | 'crit' | 'none';

export function bandOf(percentage: number | null): Band {
  const band = bandFor(percentage);
  if (!band) return 'none';
  if (band.token === 'band-outstanding' || band.token === 'band-on-track') return 'ok';
  if (band.token === 'band-improving') return 'warn';
  return 'crit';
}

/** The fill of a band, rail or track (`--ok-band` …). */
export function bandFill(band: Band, palette: Palette): string {
  if (band === 'ok') return palette.okBand;
  if (band === 'warn') return palette.warnBand;
  if (band === 'crit') return palette.critBand;
  return palette.edgeSoft;
}

/** The text colour of a figure or chip in that band (`--ok` …). */
export function bandInk(band: Band, palette: Palette): string {
  if (band === 'ok') return palette.ok;
  if (band === 'warn') return palette.warn;
  if (band === 'crit') return palette.crit;
  return palette.ink3;
}
