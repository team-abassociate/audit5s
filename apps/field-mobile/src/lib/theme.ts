import { useMemo } from 'react';
import { Platform, StyleSheet, useColorScheme, type ViewStyle } from 'react-native';
import { gemba, gembaFonts } from './gemba';
export { bandFill, bandInk, bandOf, type Band } from './gemba';

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

export function useTheme(): GembaTheme {
  return themes[useColorScheme() === 'dark' ? 'dark' : 'light'];
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
