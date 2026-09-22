import type { ExpoConfig } from 'expo/config';

/**
 * Android only. iOS is explicitly out of scope until Android is validated with real
 * auditors in a real plant (STACK.md §6), so there is no iOS block here to drift.
 *
 * `API_BASE_URL` is read from the environment at build time and surfaced through
 * `expo-constants`, so a device build points at the deployed API without a code change.
 */
const config: ExpoConfig = {
  // The Expo account that builds and signs the APK. The project and its signing key moved
  // here from abassociatess-team, so builds keep the key testers' phones already trust.
  owner: 'abassociates',
  name: 'Leanstack',
  slug: 'audit5s-field',
  version: '0.1.0',
  icon: './assets/audit5s-logo.png',
  orientation: 'portrait',
  scheme: 'audit5s',
  userInterfaceStyle: 'automatic',
  android: {
    package: 'in.abassociate.audit5s',
    versionCode: 1,
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
    /*
     * Corrective-action links open in the app when it is installed (PART 14, Phase 7).
     *
     * `autoVerify` makes this an Android App Link rather than a chooser prompt, which
     * needs `/.well-known/assetlinks.json` served from the same origin — a deployment
     * step, recorded in the runbook. Until that file is published the link still works:
     * Android simply shows the chooser, and the web page is the other option, which is
     * the correct fallback rather than a failure.
     *
     * The host comes from the environment for the same reason `apiBaseUrl` does: a
     * staging build must not claim production's links.
     */
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: process.env.WEB_APP_HOST ?? 'app.audit5s.example', pathPrefix: '/ca' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },
  plugins: [
    [
      'expo-build-properties',
      {
        /*
         * Android 9+ refuses cleartext HTTP, which a bench-test build aimed at a laptop on
         * the same Wi-Fi (`http://192.168.x.x:3000`) needs: a LAN address has no certificate.
         * Deployed behind a real hostname the API is HTTPS end to end, and this goes back to
         * the default — it is here for testing, not for the field.
         */
        android: { usesCleartextTraffic: process.env.ALLOW_CLEARTEXT === '1' },
      },
    ],
    // Gradle needs more metaspace than the default since expo-updates arrived; see the file.
    './plugins/with-gradle-memory',
    'expo-router',
    'expo-secure-store',
    'expo-font',
    'expo-sqlite',
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
  /*
   * OTA updates (STACK.md §4: "OTA updates — EAS Update, free tier").
   *
   * A JS-only fix — a wrong label, a reordered button — reaches installed phones through
   * `eas update` instead of a rebuild and a re-install. It cannot carry native changes: a
   * new permission, a new native module or an SDK bump still needs a build, because the
   * runtime on the device has to match.
   *
   * `runtimeVersion` is the contract that enforces that. `appVersion` ties a bundle to
   * `version` above, so a build with different native code will not accept an update
   * published for the old one — which is the failure this guards against, an auditor's
   * phone pulling JS that calls a native module the binary does not contain.
   *
   * `fallbackToCacheTimeout: 0` because the app is offline-first: it starts from the
   * bundle it already has and fetches in the background, so a plant with no signal opens
   * instantly rather than waiting on a network check that will fail.
   */
  updates: {
    url: 'https://u.expo.dev/71411439-1202-4ffe-bf53-55ef490216e7',
    fallbackToCacheTimeout: 0,
  },
  runtimeVersion: { policy: 'appVersion' },

  extra: { apiBaseUrl: process.env.API_BASE_URL ?? 'http://10.0.2.2:3000/api/v1', eas: { projectId: '71411439-1202-4ffe-bf53-55ef490216e7', }, },
  experiments: { typedRoutes: true },
};

if (process.env.APP_DEPLOYMENT === 'production') {
  if (!/^https:\/\/[^/]+\/api\/v1$/.test(process.env.API_BASE_URL ?? '')) {
    throw new Error('Production APK requires API_BASE_URL=https://<api-host>/api/v1');
  }
  if (!/^[a-z0-9.-]+$/i.test(process.env.WEB_APP_HOST ?? '')) {
    throw new Error('Production APK requires WEB_APP_HOST');
  }
}

export default config;
