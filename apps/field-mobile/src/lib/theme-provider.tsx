import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { loadThemePreference, saveThemePreference } from './secure-storage';
import { ThemeChoiceContext, useThemeChoice } from './theme';
import {
  DEFAULT_THEME_PREFERENCE,
  resolveTheme,
  type ThemePreference,
} from './theme-choice';

/**
 * The chosen theme, held for the app and remembered per install.
 *
 * It starts at the default rather than at whatever the OS says, and the stored preference
 * arrives a moment later. That order is deliberate: the app opens light on a phone set to
 * dark and stays light, instead of flashing dark and correcting itself — which reads as a
 * bug on every launch, and is worse than the setting simply taking a frame to load.
 *
 * Writing is fire-and-forget. A keystore that refuses the write still gives the person the
 * theme they asked for for this session; it just will not remember it, which is the right
 * trade for a display setting.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setPreference] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadThemePreference();
      if (!cancelled && stored) setPreference(stored);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = useCallback((next: ThemePreference) => {
    setPreference(next);
    void saveThemePreference(next);
  }, []);

  const value = useMemo(
    () => ({ preference, scheme: resolveTheme(preference, system), choose }),
    [preference, system, choose],
  );

  return <ThemeChoiceContext.Provider value={value}>{children}</ThemeChoiceContext.Provider>;
}

/**
 * The status-bar contents, matched to the theme rather than to the OS.
 *
 * `style="auto"` reads the OS scheme, so a phone in dark mode showing the light theme got
 * light glyphs on the light bar — legible only at the right angle, and not at all in a
 * plant. `style` names the **contents**: light glyphs for the dark theme, dark for light.
 */
export function ThemedStatusBar() {
  const { scheme } = useThemeChoice();
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
}
