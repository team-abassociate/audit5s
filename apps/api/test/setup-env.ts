import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment for the end-to-end suites.
 *
 * The signing keypair is **generated at run time**, never committed. A fixture keypair in
 * the repository would be a real RSA private key in git, and "it's only for tests" is
 * exactly how such a key ends up trusted somewhere it shouldn't be. Generating costs
 * about a tenth of a second per worker and removes the question entirely.
 *
 * Defaults point at `audit5s_test`, a database separate from the one `packages/db` uses:
 * both suites truncate and reseed, and sharing one would make them flaky the moment they
 * ran concurrently.
 */
function ensureSigningKeys(): void {
  if (process.env.JWT_PRIVATE_KEY_B64 && process.env.JWT_PUBLIC_KEY_B64) {
    return;
  }

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  process.env.JWT_PRIVATE_KEY_B64 = Buffer.from(privateKey).toString('base64');
  process.env.JWT_PUBLIC_KEY_B64 = Buffer.from(publicKey).toString('base64');
}

function fallback(name: string, value: string): void {
  process.env[name] ??= value;
}

ensureSigningKeys();

fallback('NODE_ENV', 'test');
fallback('LOG_LEVEL', 'error');
fallback(
  'DATABASE_URL',
  'postgres://audit5s_app:audit5s_app@127.0.0.1:5432/audit5s_test',
);
fallback(
  'DATABASE_MIGRATION_URL',
  'postgres://audit5s_owner:audit5s_owner@127.0.0.1:5432/audit5s_test',
);
fallback('JWT_ISSUER', 'https://api.audit5s.test');
fallback('JWT_AUDIENCE', 'audit5s');
fallback('ACCESS_TOKEN_TTL_SECONDS', '900');
fallback('REFRESH_TOKEN_TTL_DAYS', '30');
fallback('BOOTSTRAP_PASSWORD_TTL_HOURS', '72');
fallback('PGBOSS_SCHEMA', 'pgboss');

// No S3_ENDPOINT, so StorageModule selects the filesystem driver — the CI path. A fresh
// temporary directory per run keeps uploaded fixtures out of the working tree and stops
// one run's objects from being visible to the next.
fallback('OBJECT_STORAGE_LOCAL_DIR', mkdtempSync(join(tmpdir(), 'audit5s-objects-')));
