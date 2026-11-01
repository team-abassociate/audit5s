/**
 * Which palette to draw with — the whole of that decision, with no React and no React
 * Native in it.
 *
 * Kept apart from `theme.ts` so it can be tested: the test runner parses this repository's
 * own TypeScript, not React Native's Flow sources, so anything importing `react-native`
 * cannot be unit-tested here. This is the part worth testing anyway. `theme.ts` re-exports
 * every name below, so nothing outside imports this file directly.
 */

/** What the person chose. `system` follows the OS; the other two override it. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/**
 * The default follows the phone's setting (owner ruling 2026-11-01, R-76): Ledger ships a
 * light and a dark palette, and Profile → Theme overrides it either way.
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

/**
 * The palette a preference resolves to, given what the OS currently says.
 *
 * `systemScheme` is `useColorScheme()`'s value, which is `'light' | 'dark' | null` and, on
 * Android before the OS has answered, `'unspecified'`. Anything that is not exactly
 * `'dark'` resolves to light: guessing dark while the answer is still on its way is the
 * flash that makes an app look broken on every launch.
 */
export function resolveTheme(
  preference: ThemePreference,
  systemScheme: string | null | undefined,
): 'light' | 'dark' {
  if (preference === 'system') return systemScheme === 'dark' ? 'dark' : 'light';
  return preference;
}
