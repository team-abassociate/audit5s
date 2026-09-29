import { describe, expect, it } from 'vitest';
import {
  reportZoneLabel,
  zoneCodeChoices,
  zoneCodeForNumber,
  zoneDisplayLabel,
  zoneLeaderSnapshot,
  zoneNumberFromCode,
} from './zone-code';

describe('zone codes', () => {
  it('pads below 100 so a lexical sort is also the numeric one', () => {
    expect(zoneCodeForNumber(1)).toBe('Z-01');
    expect(zoneCodeForNumber(9)).toBe('Z-09');
    expect(zoneCodeForNumber(22)).toBe('Z-22');
    expect(zoneCodeForNumber(100)).toBe('Z-100');
    const codes = [1, 2, 10, 22].map(zoneCodeForNumber);
    expect([...codes].sort()).toEqual(codes);
  });

  it('offers Zone 1…100, which is the dropdown the auditor sees', () => {
    const choices = zoneCodeChoices();
    expect(choices).toHaveLength(100);
    expect(choices[0]).toEqual({ number: 1, code: 'Z-01' });
    expect(choices[99]).toEqual({ number: 100, code: 'Z-100' });
  });

  it('reads the number back out, and gives up on a code a Unit chose itself', () => {
    expect(zoneNumberFromCode('Z-01')).toBe(1);
    expect(zoneNumberFromCode('z-100')).toBe(100);
    expect(zoneNumberFromCode('PRESS-LINE')).toBeNull();
  });

  it('renders the sample report’s "Zone 1 — Press", and degrades honestly', () => {
    expect(zoneDisplayLabel('Z-01', 'Press')).toBe('Zone 1 — Press');
    expect(zoneDisplayLabel('BOILER', 'Boiler house')).toBe('BOILER — Boiler house');
  });

  it('does not say the number twice for a Zone an auditor added by number (R-19)', () => {
    expect(zoneDisplayLabel('Z-07', 'Zone 7')).toBe('Zone 7');
    expect(zoneDisplayLabel('Z-07', 'zone 7')).toBe('Zone 7');
    expect(zoneDisplayLabel('Z-07', '')).toBe('Zone 7');
  });
});

describe('reportZoneLabel — the name the auditor gave the Zone, on the reports', () => {
  it('writes the number as "Zone 1", then what the auditor typed', () => {
    expect(
      reportZoneLabel({ zoneCode: 'Z-01', zoneName: 'Zone 1', zoneDescription: 'Press Shop' }),
    ).toBe('Zone 1 — Press Shop');
    expect(
      reportZoneLabel({ zoneCode: 'Z-12', zoneName: 'Zone 12', zoneDescription: 'Dispatch bay' }),
    ).toBe('Zone 12 — Dispatch bay');
  });

  it('never prints the stored code "Z-01" for a numbered Zone', () => {
    for (const description of ['Press Shop', null]) {
      expect(
        reportZoneLabel({ zoneCode: 'Z-01', zoneName: 'Zone 1', zoneDescription: description }),
      ).not.toContain('Z-01');
    }
  });

  it('keeps a name somebody chose, before the auditor’s words', () => {
    expect(
      reportZoneLabel({ zoneCode: 'Z-07', zoneName: 'Press', zoneDescription: 'Line 2, dies 4–6' }),
    ).toBe('Zone 7 — Press — Line 2, dies 4–6');
  });

  it('keeps a code a Unit chose for itself, which has no number to write', () => {
    expect(
      reportZoneLabel({ zoneCode: 'BOILER', zoneName: 'Boiler house', zoneDescription: null }),
    ).toBe('BOILER — Boiler house');
  });

  it('does not repeat a description that is the name again', () => {
    expect(
      reportZoneLabel({ zoneCode: 'Z-07', zoneName: 'Press', zoneDescription: '  press ' }),
    ).toBe('Zone 7 — Press');
  });

  it('is just "Zone 1" when nothing was typed', () => {
    expect(reportZoneLabel({ zoneCode: 'Z-01', zoneName: 'Zone 1', zoneDescription: null })).toBe(
      'Zone 1',
    );
    expect(reportZoneLabel({ zoneCode: 'Z-01', zoneName: 'Zone 1', zoneDescription: '   ' })).toBe(
      'Zone 1',
    );
    expect(reportZoneLabel({ zoneCode: 'Z-01', zoneName: 'Zone 1' })).toBe('Zone 1');
  });

  it('prints a multi-line description on one line', () => {
    expect(
      reportZoneLabel({ zoneCode: 'Z-03', zoneName: 'Zone 3', zoneDescription: 'Dispatch\n  bay 2' }),
    ).toBe('Zone 3 — Dispatch bay 2');
  });
});

describe('zoneLeaderSnapshot (R-19)', () => {
  const zone = { zoneLeaderId: 'leader-1', zoneLeaderName: 'Priya Menon' };

  it('uses the Zone’s own leader when nothing is typed', () => {
    expect(zoneLeaderSnapshot(zone, undefined)).toEqual({ userId: 'leader-1', name: 'Priya Menon' });
    expect(zoneLeaderSnapshot(zone, '   ')).toEqual({ userId: 'leader-1', name: 'Priya Menon' });
  });

  it('keeps the account only when the typed name is that person’s', () => {
    expect(zoneLeaderSnapshot(zone, ' priya menon ')).toEqual({ userId: 'leader-1', name: 'priya menon' });
    expect(zoneLeaderSnapshot(zone, 'Ravi Kumar')).toEqual({ userId: null, name: 'Ravi Kumar' });
  });

  it('prints the typed name for a Zone with no record at all', () => {
    expect(zoneLeaderSnapshot(null, 'Ravi Kumar')).toEqual({ userId: null, name: 'Ravi Kumar' });
    expect(zoneLeaderSnapshot(undefined, null)).toEqual({ userId: null, name: null });
  });
});
