import { describe, expect, it } from 'vitest';
import { loadConfig } from './env';

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://app:password@postgres:5432/audit5s',
  JWT_PRIVATE_KEY_B64: 'cHJpdmF0ZQ==',
  JWT_PUBLIC_KEY_B64: 'cHVibGlj',
  JWT_ISSUER: 'https://api.example.test',
  JWT_AUDIENCE: 'audit5s',
};

describe('production object storage configuration', () => {
  it('refuses a missing endpoint or credentials instead of selecting local files', () => {
    expect(() => loadConfig(base)).toThrow('Production requires S3_ENDPOINT');
    expect(() =>
      loadConfig({ ...base, S3_ENDPOINT: 'https://objects.example.test' }),
    ).toThrow('Production requires S3_ENDPOINT');
  });

  it('requires a public HTTPS origin and accepts a complete S3 configuration', () => {
    const credentials = { S3_ACCESS_KEY_ID: 'app', S3_SECRET_ACCESS_KEY: 'secret' };
    expect(() =>
      loadConfig({ ...base, ...credentials, S3_ENDPOINT: 'http://objects.example.test' }),
    ).toThrow('HTTPS');
    expect(() =>
      loadConfig({ ...base, ...credentials, S3_ENDPOINT: 'https://objects.example.test/path' }),
    ).toThrow('without a path');
    expect(
      loadConfig({ ...base, ...credentials, S3_ENDPOINT: 'https://objects.example.test' })
        .S3_BUCKET,
    ).toBe('audit5s-private');
  });
});
