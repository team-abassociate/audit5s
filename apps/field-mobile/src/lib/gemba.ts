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

export function ratingColor(
  token: string,
  palette: (typeof gemba)[keyof typeof gemba],
): string {
  if (token === 'band-outstanding' || token === 'band-on-track') return palette.ok;
  if (token === 'band-improving') return palette.warn;
  return palette.crit;
}
