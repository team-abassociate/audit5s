import { bandFor } from '@audit5s/domain';

/**
 * The Ledger tokens for the phone: `docs/design/ledger-tokens.css`, the same roles in
 * camelCase. `ledger.test.ts` fails if the light bands drift from `RATING_BANDS` or a dark
 * pair loses contrast. Read through `useTheme()`, never imported by a screen.
 */
export const ledger = {
  light: {
    canvas: '#E4E7E3',
    ground: '#F4F5F2',
    surface: '#FFFFFF',
    chip: '#EEF1EF',
    ink: '#14211E',
    onInk: '#FFFFFF',
    ink2: '#3E4C48',
    muted: '#5E6B67',
    rule: '#D9DEDB',
    ruleSoft: '#E3E7E4',
    primary: '#882627',
    primaryHover: '#5E1A1B',
    onPrimary: '#FFFFFF',
    primaryInk: '#882627',
    primaryInkHover: '#5E1A1B',
    secondary: '#FFB380',
    onSecondary: '#5E1A1B',
    secondarySoft: '#FFE4D2',
    onSecondarySoft: '#5E1A1B',
    focus: '#882627',
    scrim: 'rgba(20,33,30,0.45)',
    outstanding: '#1B7F4B',
    outstandingTint: '#E2F4E9',
    onTrack: '#2A7097',
    onTrackTint: '#E2EEF7',
    improving: '#BE7D0F',
    improvingTint: '#FDF3DB',
    needsSupport: '#B3261E',
    needsSupportTint: '#FCE7E5',
  },
  dark: {
    canvas: '#0A0908',
    ground: '#141110',
    surface: '#1E1A19',
    chip: '#2E2826',
    ink: '#F3EEEC',
    onInk: '#1A1412',
    ink2: '#CFC6C3',
    muted: '#A69B97',
    rule: '#3A322F',
    ruleSoft: '#2E2826',
    primary: '#882627',
    primaryHover: '#5E1A1B',
    onPrimary: '#FFFFFF',
    primaryInk: '#FFB380',
    primaryInkHover: '#FFC9A3',
    secondary: '#FFB380',
    onSecondary: '#5E1A1B',
    secondarySoft: '#3A2320',
    onSecondarySoft: '#FFB380',
    focus: '#FFB380',
    scrim: 'rgba(0,0,0,0.6)',
    outstanding: '#5BCB8F',
    outstandingTint: '#173326',
    onTrack: '#6AB0DA',
    onTrackTint: '#152B3A',
    improving: '#E7B04A',
    improvingTint: '#3A2D12',
    needsSupport: '#F07A70',
    needsSupportTint: '#3D1A17',
  },
} as const;

/** Manrope only (LEDGER.md rule 5), loaded in `app/_layout.tsx`. */
export const ledgerFonts = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
  extraBold: 'Manrope_800ExtraBold',
} as const;

/** `--radius-*`. */
export const ledgerRadius = { cardLg: 22, card: 18, panel: 14, control: 10, chip: 6, pill: 999 } as const;

/** `--dur-micro`, `--dur-short`. */
export const ledgerDuration = { micro: 120, short: 220 } as const;

export type Palette = (typeof ledger)[keyof typeof ledger];

/** A score's band, from `packages/domain` (R-6b, 90 / 75 / 60). `none` is N/A, never a zero. */
export type Band = 'outstanding' | 'on-track' | 'improving' | 'needs-support' | 'none';

/** A status that is not a score (approved, sent back, failed …), drawn in a band's colour. */
export type Tone = 'ok' | 'warn' | 'crit' | 'none';

const TONE_BAND: Record<Tone, Band> = { ok: 'outstanding', warn: 'improving', crit: 'needs-support', none: 'none' };

export function bandOf(percentage: number | null): Band {
  const band = bandFor(percentage);
  return band ? (band.token.slice('band-'.length) as Band) : 'none';
}

const KEY = {
  outstanding: ['outstanding', 'outstandingTint'],
  'on-track': ['onTrack', 'onTrackTint'],
  improving: ['improving', 'improvingTint'],
  'needs-support': ['needsSupport', 'needsSupportTint'],
} as const;

function band(of: Band | Tone): Band {
  return of in TONE_BAND ? TONE_BAND[of as Tone] : (of as Band);
}

/** The solid colour of a band: its bars, rails and figures. */
export function bandFill(of: Band | Tone, palette: Palette): string {
  const b = band(of);
  return b === 'none' ? palette.ruleSoft : palette[KEY[b][0]];
}

/** The text colour of a figure or chip in that band. */
export function bandInk(of: Band | Tone, palette: Palette): string {
  const b = band(of);
  return b === 'none' ? palette.muted : palette[KEY[b][0]];
}

/** The chip ground of a band. On a maroon card use `ledger.light`'s tint (LEDGER.md rule 3). */
export function bandTint(of: Band | Tone, palette: Palette): string {
  const b = band(of);
  return b === 'none' ? palette.chip : palette[KEY[b][1]];
}
