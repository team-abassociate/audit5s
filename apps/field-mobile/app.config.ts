import type { ExpoConfig } from 'expo/config';

/**
 * Android only. iOS is explicitly out of scope until Android is validated with real
 * auditors in a real plant (STACK.md §6), so there is no iOS block here to drift.
 *
 * `API_BASE_URL` is read from the environment at build time and surfaced through
 * `expo-constants`, so a device build points at the deployed API without a code change.
 */
const config: ExpoConfig = {
  name: 'audit5s Field',
  slug: 'audit5s-field',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'audit5s',
  userInterfaceStyle: 'light',
  android: {
    package: 'in.abassociate.audit5s',
    versionCode: 1,
    adaptiveIcon: { backgroundColor: '#5C1816' },
    // Evidence capture and geotagging arrive in Phase 4; the permissions are declared
    // there, alongside the code that asks for them, not speculatively here.
  },
  plugins: ['expo-router', 'expo-secure-store'],
  extra: {
    apiBaseUrl: process.env.API_BASE_URL ?? 'http://10.0.2.2:3000/api/v1',
  },
  experiments: { typedRoutes: true },
};

export default config;
