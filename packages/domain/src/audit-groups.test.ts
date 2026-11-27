import { describe, expect, it } from 'vitest';
import { auditZoneTags, groupAuditsByUnit, zoneTagLabel, zoneTags } from './audit-groups';

interface Row {
  id: string;
  unitId: string;
  unitName: string;
}

const row = (id: string, unit: 'p2' | 'p5'): Row => ({ id, unitId: unit, unitName: unit === 'p2' ? 'Plant 2' : 'Plant 5' });

describe('groupAuditsByUnit', () => {
  it('keeps the list order for Units and for audits within each', () => {
    const groups = groupAuditsByUnit([row('a', 'p5'), row('b', 'p2'), row('c', 'p5'), row('d', 'p2')], (item) => item);
    expect(groups.map((unit) => [unit.unitName, unit.items.map((item) => item.id)])).toEqual([
      ['Plant 5', ['a', 'c']],
      ['Plant 2', ['b', 'd']],
    ]);
  });

  it('lists each audit once', () => {
    const [unit] = groupAuditsByUnit([row('a', 'p2')], (item) => item);
    expect(unit!.items).toHaveLength(1);
  });

  it('returns nothing for an empty list', () => {
    expect(groupAuditsByUnit([], (item: Row) => item)).toEqual([]);
  });
});

describe('zoneTags', () => {
  it('sorts the tags ascending, codes a Unit chose last, each Zone once', () => {
    expect(zoneTags([{ code: 'Z-10' }, { code: 'BOILER' }, { code: 'Z-1A' }, { code: 'Z-02' }, { code: 'Z-02' }])).toEqual([
      'Zone 1A',
      'Zone 2',
      'Zone 10',
      'BOILER',
    ]);
  });

  it('names a Zone when its name is known', () => {
    expect(zoneTags([{ code: 'Z-07' }, { code: 'Z-07', name: 'Press' }])).toEqual(['Zone 7 — Press']);
  });

  it('reads an audit from GET /audits, with names where the screen has them', () => {
    const audit = { zoneIds: ['z4', 'z1'], zoneCodes: ['Z-04', 'Z-01'] };
    expect(auditZoneTags(audit)).toEqual(['Zone 1', 'Zone 4']);
    expect(auditZoneTags(audit, new Map([['z1', 'Press shop']]))).toEqual(['Zone 1 — Press shop', 'Zone 4']);
    expect(auditZoneTags({})).toEqual([]);
  });
});

describe('zoneTagLabel', () => {
  it('writes the Zone as everywhere else', () => {
    expect(zoneTagLabel({ code: 'Z-07' })).toBe('Zone 7');
    expect(zoneTagLabel({ code: 'Z-07', name: 'Zone 7' })).toBe('Zone 7');
    expect(zoneTagLabel({ code: 'BOILER' })).toBe('BOILER');
  });
});
