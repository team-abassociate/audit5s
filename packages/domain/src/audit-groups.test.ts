import { describe, expect, it } from 'vitest';
import {
  NO_ZONE_KEY,
  NO_ZONE_LABEL,
  auditGroupZones,
  flattenAuditGroups,
  groupAuditsByUnitAndZone,
  groupZoneLabel,
} from './audit-groups';

interface Row {
  id: string;
  unitId: string;
  unitName: string;
  zoneIds?: string[];
  zoneCodes?: string[];
}

const row = (id: string, unit: 'p2' | 'p5', zones: Array<[string, string]> = []): Row => ({
  id,
  unitId: unit,
  unitName: unit === 'p2' ? 'Plant 2' : 'Plant 5',
  zoneIds: zones.map(([zoneId]) => zoneId),
  zoneCodes: zones.map(([, code]) => code),
});

const describeRow = (item: Row) => ({ unitId: item.unitId, unitName: item.unitName, zones: auditGroupZones(item) });
const ids = (items: Row[]) => items.map((item) => item.id);

describe('groupAuditsByUnitAndZone', () => {
  it('keeps the list order for Units and audits, and puts Zones in ascending order', () => {
    const groups = groupAuditsByUnitAndZone(
      [
        row('a', 'p5', [['z7', 'Z-07']]),
        row('b', 'p2', [['z10', 'Z-10']]),
        row('c', 'p5', [['z1a', 'Z-1A']]),
        row('d', 'p5', [['z7', 'Z-07']]),
        row('e', 'p2', [['zb', 'BOILER']]),
        row('f', 'p2', [['z2', 'Z-02']]),
      ],
      describeRow,
    );
    expect(groups.map((unit) => unit.unitName)).toEqual(['Plant 5', 'Plant 2']);
    expect(groups[0]!.zones.map((zone) => zone.label)).toEqual(['Zone 1A', 'Zone 7']);
    expect(ids(groups[0]!.zones[1]!.items)).toEqual(['a', 'd']);
    expect(groups[1]!.zones.map((zone) => zone.label)).toEqual(['Zone 2', 'Zone 10', 'BOILER']);
  });

  it('lists an audit of several Zones under each, and counts it once', () => {
    const [unit] = groupAuditsByUnitAndZone(
      [
        row('a', 'p2', [
          ['z4', 'Z-04'],
          ['z1', 'Z-01'],
        ]),
        row('b', 'p2', [['z4', 'Z-04']]),
      ],
      describeRow,
    );
    expect(unit!.total).toBe(2);
    expect(unit!.zones.map((zone) => [zone.label, ids(zone.items)])).toEqual([
      ['Zone 1', ['a']],
      ['Zone 4', ['a', 'b']],
    ]);
  });

  it('puts audits with no Zone last, under their own heading', () => {
    const [unit] = groupAuditsByUnitAndZone([row('a', 'p2'), row('b', 'p2', [['z3', 'Z-03']])], describeRow);
    expect(unit!.zones.map((zone) => [zone.key, zone.label])).toEqual([
      ['z3', 'Zone 3'],
      [NO_ZONE_KEY, NO_ZONE_LABEL],
    ]);
  });

  it('names a Zone when the screen knows its name', () => {
    const names = new Map([['z3', 'Press shop']]);
    const [unit] = groupAuditsByUnitAndZone([row('a', 'p2', [['z3', 'Z-03']])], (item) => ({
      ...describeRow(item),
      zones: auditGroupZones(item, names),
    }));
    expect(unit!.zones[0]!.label).toBe('Zone 3 — Press shop');
  });

  it('returns nothing for an empty list', () => {
    expect(groupAuditsByUnitAndZone([], describeRow)).toEqual([]);
  });
});

describe('flattenAuditGroups', () => {
  it('gives each Zone a section and the Unit to its first Zone only', () => {
    const sections = flattenAuditGroups(
      groupAuditsByUnitAndZone(
        [row('a', 'p2', [['z1', 'Z-01']]), row('b', 'p2', [['z2', 'Z-02']]), row('c', 'p5', [['z1', 'Z-01']])],
        describeRow,
      ),
    );
    expect(sections.map((section) => [section.key, section.unit?.unitName ?? null, section.zone.label])).toEqual([
      ['p2:z1', 'Plant 2', 'Zone 1'],
      ['p2:z2', null, 'Zone 2'],
      ['p5:z1', 'Plant 5', 'Zone 1'],
    ]);
  });
});

describe('groupZoneLabel', () => {
  it('writes the Zone as everywhere else', () => {
    expect(groupZoneLabel({ code: 'Z-07' })).toBe('Zone 7');
    expect(groupZoneLabel({ code: 'Z-07', name: 'Press' })).toBe('Zone 7 — Press');
    expect(groupZoneLabel({ code: 'BOILER' })).toBe('BOILER');
  });
});
