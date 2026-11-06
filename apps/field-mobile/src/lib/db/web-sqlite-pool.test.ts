import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const metro = createRequire(import.meta.url)('../../../metro.config.js');
const resolve = (moduleName: string, origin: string, platform: string) =>
  metro.resolver.resolveRequest({ originModulePath: origin, resolveRequest: () => ({ type: 'untouched' }) }, moduleName, platform);

describe("the browser's SQLite file pool (error 14)", () => {
  const worker = '/repo/node_modules/expo-sqlite/web/worker.ts';
  const pool = './wa-sqlite/AccessHandlePoolVFS';

  it("replaces expo-sqlite's pool on the web, for its worker only", () => {
    expect(resolve(pool, worker, 'web').filePath).toMatch(/web-sqlite-pool\.js$/);
    expect(resolve(pool, worker.split('/').join(path.win32.sep), 'web').filePath).toMatch(/web-sqlite-pool\.js$/);
    expect(resolve(pool, worker, 'android').type).toBe('untouched');
    expect(resolve(pool, '/repo/src/other.ts', 'web').type).toBe('untouched');
  });

  it('still finds the original, so an expo-sqlite upgrade cannot quietly drop this', () => {
    expect(existsSync(resolve('expo-sqlite-original-pool', '/x.js', 'web').filePath)).toBe(true);
  });
});
