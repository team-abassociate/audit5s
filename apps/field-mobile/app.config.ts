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
    /*
     * Exactly the permissions Phase 4's code asks for, and no more.
     *
     * `CAMERA` for live capture (§12.10) and the two location permissions for §12.9's
     * reading. There is deliberately **no** `READ_MEDIA_IMAGES`: §12.10 requires that no
     * gallery picker exists in these flows, and a permission the app cannot use is a
     * permission an auditor is asked to grant for nothing.
     */
    permissions: ['android.permission.CAMERA', 'android.permission.ACCESS_FINE_LOCATION',
                  'android.permission.ACCESS_COARSE_LOCATION'],
    blockedPermissions: ['android.permission.RECORD_AUDIO'],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-camera',
      {
        cameraPermission:
          'audit5s records photographic evidence of what was found during an audit.',
        // Stills only. The flows take photographs, and a microphone permission the app
        // never uses is one an auditor has no reason to grant.
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission:
          'audit5s records where an audit was started. Location is supporting evidence for ' +
          'a reviewer, never an automated gate — an audit is never blocked on it.',
      },
    ],
  ],
  extra: {
    apiBaseUrl: process.env.API_BASE_URL ?? 'http://10.0.2.2:3000/api/v1',
  },
  experiments: { typedRoutes: true },
};

export default config;
