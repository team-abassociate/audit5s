import { describe, expect, it } from 'vitest';
import { isUsable } from './report-tokens.service';

/**
 * R-41: with `REPORT_TOKEN_TTL_DAYS=0` a corrective-action link has no time limit — and
 * that includes the links already printed in PDFs under the old 30-day limit, whose stored
 * expiry the database will not let anyone change.
 */
const printedLastMonth = {
  revokedAt: null,
  expiresAt: new Date(Date.now() - 86_400_000),
  maxUses: null,
  useCount: 12,
};

describe('isUsable', () => {
  it('keeps a link whose stored expiry has passed working when there is no limit', () => {
    expect(isUsable(printedLastMonth, false)).toBe(true);
  });

  it('still refuses it when a limit is configured', () => {
    expect(isUsable(printedLastMonth, true)).toBe(false);
  });

  it('refuses a revoked link, limit or not', () => {
    const revoked = { ...printedLastMonth, revokedAt: new Date() };
    expect(isUsable(revoked, false)).toBe(false);
    expect(isUsable(revoked, true)).toBe(false);
  });
});
