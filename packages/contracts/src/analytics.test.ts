import { describe, expect, it } from 'vitest';
import { unitScoreTrendSchema } from './analytics';

const unitId = '00000000-0000-4000-8000-000000000001';
const point = { auditId: '00000000-0000-4000-8000-000000000002', completedAt: '2026-09-01T10:00:00.000Z', scorePercentage: 72.5 };

describe('unitScoreTrendSchema', () => {
  it('accepts a Unit with a signed change and the instant it is measured from', () => {
    const trend = { unitId, unitName: 'Pune', points: [point, point], change: -4.2, changeFrom: point.completedAt };
    expect(unitScoreTrendSchema.parse(trend)).toEqual(trend);
  });

  it('accepts a Unit with no audits and no change', () => {
    expect(unitScoreTrendSchema.safeParse({ unitId, unitName: 'Nashik', points: [], change: null, changeFrom: null }).success).toBe(true);
  });

  it('rejects a score off the 0–100 scale and a missing change', () => {
    expect(unitScoreTrendSchema.safeParse({ unitId, unitName: 'X', points: [{ ...point, scorePercentage: 101 }], change: null, changeFrom: null }).success).toBe(false);
    expect(unitScoreTrendSchema.safeParse({ unitId, unitName: 'X', points: [] }).success).toBe(false);
  });
});
