import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './env';

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://app:password@postgres:5432/audit5s',
  JWT_PRIVATE_KEY_B64: 'cHJpdmF0ZQ==',
  JWT_PUBLIC_KEY_B64: 'cHVibGlj',
  JWT_ISSUER: 'https://api.example.test',
  JWT_AUDIENCE: 'audit5s',
  // Named explicitly: the default is a loopback address, which production now refuses.
  WEB_APP_URL: 'https://app.example.test',
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

/**
 * The address every corrective-action link is built from.
 *
 * This is checked at boot rather than at render because it is frozen into the report
 * payload when a snapshot is minted: a PDF issued against a LAN address carries that
 * address permanently, and correcting the setting afterwards does not rewrite the document
 * somebody has already been sent. It is also a failure that hides itself — the auditor who
 * generated the report is on the network where the link works.
 */
describe('WEB_APP_URL reachability', () => {
  const storage = {
    S3_ENDPOINT: 'https://objects.example.test',
    S3_ACCESS_KEY_ID: 'app',
    S3_SECRET_ACCESS_KEY: 'secret',
  };
  const production = { ...base, ...storage };

  it.each([
    ['http://127.0.0.1:5173', 'loopback'],
    ['http://localhost:5173', 'loopback'],
    ['https://192.168.68.185:5173', 'private LAN'],
    ['https://10.4.1.9', 'private LAN'],
    ['https://172.20.0.4', 'private LAN'],
    ['https://169.254.11.2', 'link-local'],
    ['https://audit.local', 'public hostname'],
    ['https://audit', 'public hostname'],
  ])('refuses %s in production', (WEB_APP_URL, reason) => {
    expect(() => loadConfig({ ...production, WEB_APP_URL })).toThrow(reason);
  });

  it('accepts a public hostname', () => {
    expect(loadConfig({ ...production, WEB_APP_URL: 'https://audit.abassociates.in' }).WEB_APP_URL)
      .toBe('https://audit.abassociates.in');
  });

  /**
   * 172.16.0.0/12 only — 172.15 and 172.32 are ordinary public addresses, and a guard that
   * rejected them would refuse a legitimate deployment.
   */
  it('reads the 172.16/12 boundaries correctly', () => {
    expect(() => loadConfig({ ...production, WEB_APP_URL: 'https://172.15.0.1' })).not.toThrow();
    expect(() => loadConfig({ ...production, WEB_APP_URL: 'https://172.32.0.1' })).not.toThrow();
    expect(() => loadConfig({ ...production, WEB_APP_URL: 'https://172.16.0.1' })).toThrow();
    expect(() => loadConfig({ ...production, WEB_APP_URL: 'https://172.31.255.254' })).toThrow();
  });

  /**
   * Development keeps working on a LAN address — that is the whole point of the Vite HTTPS
   * setup — but says so, once, at boot rather than from a report already issued.
   */
  it('warns rather than refuses outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const config = loadConfig({
        ...base,
        NODE_ENV: 'development',
        WEB_APP_URL: 'https://192.168.68.185:5173',
      });
      expect(config.WEB_APP_URL).toBe('https://192.168.68.185:5173');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain('only open on this network');
    } finally {
      warn.mockRestore();
    }
  });
});
