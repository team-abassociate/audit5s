import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_PREFERENCE,
  isThemePreference,
  resolveTheme,
  THEME_PREFERENCES,
} from './theme-choice';

/**
 * The owner's ruling of 2026-11-01 (R-76), replacing the light default of 2026-09-20: the
 * app follows the phone's setting until somebody picks light or dark.
 */
describe('the chosen theme', () => {
  it('defaults to the system setting', () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe('system');
    expect(resolveTheme(DEFAULT_THEME_PREFERENCE, 'dark')).toBe('dark');
    expect(resolveTheme(DEFAULT_THEME_PREFERENCE, 'light')).toBe('light');
  });

  it('honours an explicit choice over the phone', () => {
    expect(resolveTheme('dark', 'light')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe('light');
  });

  it('follows the phone only under `system`, and treats anything unknown as light', () => {
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('system', 'light')).toBe('light');
    // Android reports `unspecified` before the OS has answered, and `useColorScheme` can
    // return null. Neither is "dark", and guessing dark there is the flash this avoids.
    expect(resolveTheme('system', null)).toBe('light');
    expect(resolveTheme('system', 'unspecified')).toBe('light');
  });

  it('accepts only the three stored values', () => {
    for (const preference of THEME_PREFERENCES) {
      expect(isThemePreference(preference)).toBe(true);
    }
    // A keystore holding something from another build must read as "no preference".
    expect(isThemePreference('midnight')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });
});
