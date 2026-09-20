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
 * The default, and it is **light** rather than the OS setting.
 *
 * GEMBA-BOARD §7 makes light the default on the web for the reason it is the default here
 * too: this is a document, and a document is white. A phone left on the system's dark mode
 * — many are, for battery — would otherwise open a 5S audit in dark grey, and §9 is
 * explicit that the field app's high-contrast values are a sunlight-and-gloves
 * requirement. Someone who wants dark still says so, and is then followed everywhere.
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light';

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
