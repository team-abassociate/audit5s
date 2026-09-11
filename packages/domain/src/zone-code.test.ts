import { describe, expect, it } from 'vitest';
import { zoneCodeChoices, zoneCodeForNumber, zoneDisplayLabel, zoneNumberFromCode } from './zone-code';

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
});
