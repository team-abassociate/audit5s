const { withGradleProperties } = require('expo/config-plugins');

/**
 * Raises the Gradle daemon's heap and metaspace.
 *
 * Expo's generated `gradle.properties` ships `-Xmx2048m -XX:MaxMetaspaceSize=512m`. That
 * was enough until `expo-updates` arrived: it pulls in expo-updates-interface,
 * expo-manifests, expo-structured-headers, expo-json-utils and expo-eas-client, and the
 * added Kotlin/KSP compilation exhausts a 512m metaspace. The daemon then throws
 * `OutOfMemoryError: Metaspace` in a loop, `:expo-updates:kspReleaseKotlin` fails, and the
 * CMake configure tasks fail behind it — a wedged build rather than a clean error.
 *
 * `android/` is gitignored and regenerated from this config on every build (CNG), so a
 * hand-edit of `gradle.properties` would not survive. This plugin is the only place the
 * change persists, and it applies to a cloud EAS build and a `--local` one alike.
 */
module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (cfg) => {
    const want = {
      'org.gradle.jvmargs': '-Xmx4096m -XX:MaxMetaspaceSize=2048m -XX:+HeapDumpOnOutOfMemoryError',
    };

    for (const [key, value] of Object.entries(want)) {
      const existing = cfg.modResults.find((item) => item.type === 'property' && item.key === key);
      if (existing) {
        existing.value = value;
      } else {
        cfg.modResults.push({ type: 'property', key, value });
      }
    }

    return cfg;
  });
};
