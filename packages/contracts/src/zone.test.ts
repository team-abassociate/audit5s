import { describe, expect, it } from 'vitest';
import { createZoneRequestSchema, zoneCodeSchema } from './zone';

describe('zoneCodeSchema', () => {
  it('stores one spelling of a Zone number', () => {
    expect(zoneCodeSchema.parse('z-7')).toBe('Z-07');
    expect(zoneCodeSchema.parse('Z-007')).toBe('Z-07');
    expect(zoneCodeSchema.parse('Z-100')).toBe('Z-100');
  });

  it('refuses a code that is not a Zone number 1 to 100', () => {
    for (const code of ['BOILER', 'Z-0', 'Z-101', 'Z-', '7']) {
      expect(zoneCodeSchema.safeParse(code).success).toBe(false);
    }
  });
});

describe('createZoneRequestSchema', () => {
  it('needs the number, not the name', () => {
    expect(createZoneRequestSchema.safeParse({ code: 'Z-03' }).success).toBe(true);
    expect(createZoneRequestSchema.safeParse({ name: 'Press' }).success).toBe(false);
  });
});
