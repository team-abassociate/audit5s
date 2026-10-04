import { describe, expect, it } from 'vitest';
import { integrityDigestDataSchema, overdueBundleDataSchema } from './notification';

const zoneId = '00000000-0000-4000-8000-000000000001';
const actionId = '00000000-0000-4000-8000-000000000002';
const unitId = '00000000-0000-4000-8000-000000000003';

describe('overdueBundleDataSchema', () => {
  const bundle = {
    zoneId,
    zoneCode: 'Z-02',
    zoneName: 'Press',
    assigneeName: 'Sunita Rao',
    items: [
      { actionId, questionNo: 12, suggestionNo: null, daysOverdue: 3 },
      { actionId, questionNo: null, suggestionNo: 1, daysOverdue: 0 },
    ],
  };

  it('accepts a Zone’s bundle, a typed or missing leader included', () => {
    expect(overdueBundleDataSchema.parse(bundle)).toEqual(bundle);
    expect(overdueBundleDataSchema.safeParse({ ...bundle, assigneeName: null }).success).toBe(true);
  });

  it('rejects an empty bundle and a pre-D10 single-item row', () => {
    expect(overdueBundleDataSchema.safeParse({ ...bundle, items: [] }).success).toBe(false);
    expect(
      overdueBundleDataSchema.safeParse({ zoneCode: 'Z-02', zoneName: 'Press', questionNo: 12, daysOverdue: 3 }).success,
    ).toBe(false);
  });
});

describe('integrityDigestDataSchema', () => {
  const unit = { unitId, unitName: 'Pune', orphanEvidence: 1, staleAudits: 0, unsyncedDevices: 0, scoreDrift: 0, auditsSampled: 20 };

  it('accepts a night with the Units that had findings', () => {
    expect(integrityDigestDataSchema.parse({ night: '2026-10-05', units: [unit] })).toEqual({ night: '2026-10-05', units: [unit] });
  });

  it('rejects an empty summary, a negative count and a pre-D10 per-Unit row', () => {
    expect(integrityDigestDataSchema.safeParse({ night: '2026-10-05', units: [] }).success).toBe(false);
    expect(integrityDigestDataSchema.safeParse({ night: '2026-10-05', units: [{ ...unit, scoreDrift: -1 }] }).success).toBe(false);
    expect(integrityDigestDataSchema.safeParse({ orphanEvidence: 1, staleAudits: 0 }).success).toBe(false);
  });
});
