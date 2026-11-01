import { createContext, useContext, useMemo } from 'react';
import { StyleSheet, useColorScheme, type ViewStyle } from 'react-native';
import { ledger, ledgerDuration, ledgerFonts, ledgerRadius } from './ledger';
import { DEFAULT_THEME_PREFERENCE, resolveTheme, type ThemePreference } from './theme-choice';
export { bandFill, bandInk, bandOf, bandTint, type Band, type Tone } from './ledger';
// The choice itself is pure and lives next door, so it can be tested; every screen still
// imports it from here.
export {
  DEFAULT_THEME_PREFERENCE,
  isThemePreference,
  resolveTheme,
  THEME_LABELS,
  THEME_PREFERENCES,
  type ThemePreference,
} from './theme-choice';

const shared = {
  space: { xs: 4, sm: 8, md: 14, lg: 22, xl: 28 },
  font: { label: 11, sm: 13, base: 15, panel: 16, heading: 19, figure: 29, hero: 52 },
  family: ledgerFonts,
  radius: ledgerRadius,
  /** `--dur-micro` / `--dur-short`: transform and opacity only, ease-out. */
  dur: ledgerDuration,
} as const;

export const themes = {
  light: { color: ledger.light, ...shared },
  dark: { color: ledger.dark, ...shared },
} as const;

export type LedgerTheme = (typeof themes)[keyof typeof themes];

export interface ThemeChoice {
  /** What the person chose, which is what the Profile screen ticks. */
  preference: ThemePreference;
  /** What that resolves to right now. */
  scheme: 'light' | 'dark';
  choose(preference: ThemePreference): void;
}

/**
 * The chosen theme, provided by `ThemeProvider` (`theme-provider.tsx`).
 *
 * `null` until one is mounted, which is the case in a unit test rendering a component on
 * its own; `useTheme` then falls back to the default rather than throwing, because a
 * missing preference must never be the reason a screen does not draw.
 */
export const ThemeChoiceContext = createContext<ThemeChoice | null>(null);

/** The chosen theme and the setter. Only the Profile screen needs the setter. */
export function useThemeChoice(): ThemeChoice {
  const chosen = useContext(ThemeChoiceContext);
  const system = useColorScheme();
  return (
    chosen ?? {
      preference: DEFAULT_THEME_PREFERENCE,
      scheme: resolveTheme(DEFAULT_THEME_PREFERENCE, system),
      choose: () => undefined,
    }
  );
}

export function useTheme(): LedgerTheme {
  return themes[useThemeChoice().scheme];
}

export function createThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (theme: LedgerTheme) => T,
): () => T {
  return function useStyles() {
    const theme = useTheme();
    return useMemo(() => StyleSheet.create(factory(theme)), [theme]);
  };
}

/** The 5S and Kaizen tab bar: a surface bar over a soft rule. */
export function tabBarStyle(theme: LedgerTheme): ViewStyle {
  return {
    minHeight: 64,
    backgroundColor: theme.color.surface,
    borderTopWidth: 1,
    borderTopColor: theme.color.rule,
    elevation: 0,
  };
}
