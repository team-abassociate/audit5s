import type { ExpoConfig } from 'expo/config';

/**
 * Android only. iOS is explicitly out of scope until Android is validated with real
 * auditors in a real plant (STACK.md §6), so there is no iOS block here to drift.
 *
 * `API_BASE_URL` is read from the environment at build time and surfaced through
 * `expo-constants`, so a device build points at the deployed API without a code change.
 */
/**
 * The field APK is installed over mobile data by testers and auditors, so its size is a
 * product requirement: under 30 MB (136 MB at build 12; 26.5 MB at build 13). Production builds only —
 * a development or preview build keeps every ABI so it still runs on an x86 emulator.
 *
 *   - `buildArchs: ['arm64-v8a']` — the one ABI a plant phone runs. x86 and x86_64 exist
 *     only for emulators (59 MB of the 136), and armeabi-v7a only for 32-bit phones. A
 *     32-bit-only phone cannot install this APK; build a separate one for it if needed.
 *   - `useLegacyPackaging` — native libraries are stored compressed in the APK rather than
 *     page-aligned and uncompressed. A smaller download; Android unpacks them on install.
 *   - R8 minify and resource shrinking — the Java/Kotlin code shrank from 57 MB raw.
 */
const productionBuild = process.env.APP_DEPLOYMENT === 'production';

const config: ExpoConfig = {
  // The Expo account that builds and signs the APK. The project and its signing key moved
  // here from abassociatess-team, so builds keep the key testers' phones already trust.
  owner: 'abassociates',
  name: 'Leanstack',
  slug: 'audit5s-field',
  version: '0.2.0',
  icon: './assets/audit5s-logo.png',
  orientation: 'portrait',
  scheme: 'audit5s',
  userInterfaceStyle: 'automatic',
  android: {
    package: 'in.abassociate.audit5s',
    versionCode: 1,
    /*
     * Exactly the permissions the code asks for, and no more: `CAMERA`, for live capture
     * (§12.10), asked once at launch.
     *
     * Location is **blocked**, not merely absent: the product owner dropped location
     * capture entirely on 2026-09-29, and blocking it stops any library from adding it
     * back through its own manifest.
     *
     * The gallery (R-38, overall corrective actions only) needs **no** permission: it is
     * Android's system photo picker, which hands the app the one photograph the person
     * chose and nothing else. `expo-image-picker`'s manifest still asks for the old storage
     * permissions, so they are blocked here, with the media ones — no screen reads the
     * photo library itself.
     */
    permissions: ['android.permission.CAMERA'],
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_MEDIA_IMAGES',
      'android.permission.READ_MEDIA_VIDEO',
      'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      'android.permission.RECORD_AUDIO',
      // expo-haptics asks for it for its vibrator calls; the app uses Android's haptic
      // feedback instead (src/lib/haptics.ts), which needs no permission.
      'android.permission.VIBRATE',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
    ],
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
        android: {
          usesCleartextTraffic: process.env.ALLOW_CLEARTEXT === '1',
          ...(productionBuild
            ? {
                buildArchs: ['arm64-v8a'],
                useLegacyPackaging: true,
                enableMinifyInReleaseBuilds: true,
                enableShrinkResourcesInReleaseBuilds: true,
              }
            : {}),
        },
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
        // Nothing scans a barcode. Note: with expo-camera 57 the ML Kit library
        // (libbarhopper, ~5 MB) is still packaged at build 13 despite this flag.
        barcodeScannerEnabled: false,
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
