import { createContext, useContext, useMemo } from 'react';
import { Platform, StyleSheet, useColorScheme, type ViewStyle } from 'react-native';
import { gemba, gembaFonts } from './gemba';
import { DEFAULT_THEME_PREFERENCE, resolveTheme, type ThemePreference } from './theme-choice';
export { bandFill, bandInk, bandOf, type Band } from './gemba';
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
  font: { label: 11, sm: 13, base: 15, panel: 16, heading: 19, figure: 29 },
  family: gembaFonts,
} as const;

export const themes = {
  light: { color: gemba.light, ...shared },
  dark: { color: gemba.dark, ...shared },
} as const;

export type GembaTheme = (typeof themes)[keyof typeof themes];

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

export function useTheme(): GembaTheme {
  return themes[useThemeChoice().scheme];
}

export function createThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (theme: GembaTheme) => T,
): () => T {
  return function useStyles() {
    const theme = useTheme();
    return useMemo(() => StyleSheet.create(factory(theme)), [theme]);
  };
}

export function iosHardShadow(color: string, offset = 3): ViewStyle {
  return Platform.OS === 'ios'
    ? {
        shadowOffset: { width: offset, height: offset },
        shadowRadius: 0,
        shadowOpacity: 1,
        shadowColor: color,
      }
    : {};
}
