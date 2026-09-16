import { describe, expect, it } from 'vitest';
import { RATING_BANDS, RESPONSE_TOKENS, BRAND_TOKENS, bandFor } from './rating-scale';

describe('bandFor', () => {
  it('maps the four boundaries measured from the sample reports (R-6b)', () => {
    expect(bandFor(100)?.token).toBe('band-outstanding');
    expect(bandFor(90)?.token).toBe('band-outstanding');
    expect(bandFor(89.99)?.token).toBe('band-on-track');
    expect(bandFor(75)?.token).toBe('band-on-track');
    expect(bandFor(74.99)?.token).toBe('band-improving');
    expect(bandFor(60)?.token).toBe('band-improving');
    expect(bandFor(59.99)?.token).toBe('band-needs-support');
    expect(bandFor(0)?.token).toBe('band-needs-support');
  });

  it('puts the third boundary at 60, not the 50 the old placeholder carried', () => {
    expect(bandFor(55)?.token).toBe('band-needs-support');
    expect(bandFor(65)?.token).toBe('band-improving');
  });

  it('reproduces the sample reports’ own figures', () => {
    // sample-zone-report.pdf: 75 / 100 = 75.0% → On Track
    expect(bandFor(75)?.label).toBe('On Track');
    // sample-summary-report.pdf: 1280 / 2092 = 61.2% → Improving
    expect(bandFor(61.2)?.label).toBe('Improving');
  });

  it('returns null for a fully-NA score, which is not a band (D4)', () => {
    expect(bandFor(null)).toBeNull();
    expect(bandFor(Number.NaN)).toBeNull();
  });

  it('carries the exact colours and tints', () => {
    expect(bandFor(95)).toMatchObject({ color: '#1B7F4B', tint: '#E2F4E9' });
    expect(bandFor(80)).toMatchObject({ color: '#2A7097', tint: '#E2EEF7' });
    expect(bandFor(65)).toMatchObject({ color: '#BE7D0F', tint: '#FDF3DB' });
    expect(bandFor(30)).toMatchObject({ color: '#B3261E', tint: '#FCE7E5' });
  });
});

describe('RATING_BANDS', () => {
  it('is ordered high to low, which is the order the report pills render in', () => {
    const bounds = RATING_BANDS.map((b) => b.minPercentage);
    expect(bounds).toEqual([90, 75, 60, 0]);
  });

  it('carries the labels from the samples, not the placeholder labels', () => {
    expect(RATING_BANDS.map((b) => b.label)).toEqual([
      'Outstanding',
      'On Track',
      'Improving',
      'Needs Support',
    ]);
  });
});

describe('RESPONSE_TOKENS', () => {
  it('weights NA as null rather than zero — it is excluded, not failed (D3)', () => {
    expect(RESPONSE_TOKENS.SCORE_2?.marks).toBe(2);
    expect(RESPONSE_TOKENS.SCORE_1?.marks).toBe(1);
    expect(RESPONSE_TOKENS.SCORE_0?.marks).toBe(0);
    expect(RESPONSE_TOKENS.NA?.marks).toBeNull();
  });

  it('uses the report response labels', () => {
    expect(RESPONSE_TOKENS.SCORE_2?.label).toBe('Well implemented');
    expect(RESPONSE_TOKENS.SCORE_1?.label).toBe('Progressing well');
    expect(RESPONSE_TOKENS.SCORE_0?.label).toBe('Needs improvement');
  });
});

describe('BRAND_TOKENS', () => {
  it('carries the report chrome palette', () => {
    expect(BRAND_TOKENS.ink).toBe('#1D1B16');
    expect(BRAND_TOKENS.accent).toBe('#0B6E77');
  });
});
