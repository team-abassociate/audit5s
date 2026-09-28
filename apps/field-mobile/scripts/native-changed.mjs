#!/usr/bin/env node
/**
 * Has the native layer changed since the APK the phones are running?
 *
 *   node scripts/native-changed.mjs <baseline-project-root>
 *
 * Compares Expo's native fingerprint of this project with that of the same project checked
 * out at the commit the installed APK was built from (`native-baseline.txt`). An OTA update
 * carries JavaScript only: sent to a binary whose native code does not match, it calls a
 * module that is not there and the app crashes on the auditor's phone. So the automatic
 * OTA publish (`.github/workflows/deploy.yml`) runs this first and stops if anything native
 * differs — a new native package, a permission, a config plugin, an SDK bump.
 *
 * Exit 0: same native layer, safe to publish. Exit 3: changed — build a new APK instead.
 * Both checkouts must be installed and evaluated under the same environment variables,
 * because `app.config.ts` reads them and its result is part of the fingerprint.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const here = resolve(import.meta.dirname, '..');

// Child mode: one project's fingerprint, as JSON. Each project is fingerprinted in its own
// process — Expo records the config-plugin files it loads, and a second project evaluated in
// the same process finds them already in the module cache and records fewer of them.
if (process.argv[2] === '--one') {
  const require = createRequire(import.meta.url);
  // A dependency of `expo` rather than of this app, so it is resolved from there.
  const { createFingerprintAsync } = require(
    require.resolve('@expo/fingerprint', { paths: [require.resolve('expo/package.json')] }),
  );
  const fingerprint = await createFingerprintAsync(resolve(process.argv[3]), { platforms: ['android'] });
  process.stdout.write(
    JSON.stringify({
      hash: fingerprint.hash,
      sources: fingerprint.sources.map((source) => [source.filePath ?? source.id ?? source.type, source.hash]),
    }),
  );
  process.exit(0);
}

const baselineRoot = process.argv[2];
if (!baselineRoot) {
  console.error('usage: node scripts/native-changed.mjs <baseline-project-root>');
  process.exit(2);
}

const say = (line) => process.stdout.write(`${line}
`);

const fingerprintOf = (root) =>
  JSON.parse(
    execFileSync(process.execPath, [import.meta.filename, '--one', resolve(root)], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

const current = fingerprintOf(here);
const baseline = fingerprintOf(baselineRoot);

say(`native fingerprint now:      ${current.hash}`);
say(`native fingerprint of APK:   ${baseline.hash}`);

if (current.hash === baseline.hash) {
  say('Native layer unchanged: an OTA update is safe.');
  process.exit(0);
}

const before = new Map(baseline.sources);
const after = new Map(current.sources);
say('Native layer changed since the installed APK:');
for (const name of new Set([...before.keys(), ...after.keys()])) {
  if (!before.has(name)) say(`  added:   ${name}`);
  else if (!after.has(name)) say(`  removed: ${name}`);
  else if (before.get(name) !== after.get(name)) say(`  changed: ${name}`);
}
process.exit(3);
