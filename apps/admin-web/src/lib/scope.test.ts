import { describe, expect, it } from 'vitest';
import { ALL_UNITS, resolveUnitScope, validateScopeSearch } from './scope';

const A = 'unit-a';
const B = 'unit-b';
const units = [A, B];

describe('resolveUnitScope', () => {
  it('uses the Unit the URL names when the caller can see it', () => {
    expect(resolveUnitScope({ wanted: B, last: A, unitIds: units, allowAll: false })).toBe(B);
  });

  it('gives "All Units" only where it is allowed', () => {
    expect(resolveUnitScope({ wanted: ALL_UNITS, last: null, unitIds: units, allowAll: true })).toBeNull();
    expect(resolveUnitScope({ wanted: ALL_UNITS, last: B, unitIds: units, allowAll: false })).toBe(B);
    expect(resolveUnitScope({ wanted: ALL_UNITS, last: null, unitIds: units, allowAll: false })).toBe(A);
  });

  it('never uses a Unit the caller cannot see', () => {
    expect(resolveUnitScope({ wanted: 'someone-elses', last: B, unitIds: units, allowAll: true })).toBe(B);
    expect(resolveUnitScope({ wanted: 'someone-elses', last: 'gone', unitIds: units, allowAll: false })).toBe(A);
  });

  it('with nothing asked for, shows all where allowed, else the last or first Unit', () => {
    expect(resolveUnitScope({ wanted: undefined, last: B, unitIds: units, allowAll: true })).toBeNull();
    expect(resolveUnitScope({ wanted: null, last: B, unitIds: units, allowAll: false })).toBe(B);
    expect(resolveUnitScope({ wanted: null, last: null, unitIds: units, allowAll: false })).toBe(A);
  });

  it('is empty when the caller sees no Unit', () => {
    expect(resolveUnitScope({ wanted: A, last: A, unitIds: [], allowAll: false })).toBe('');
  });
});

describe('validateScopeSearch', () => {
  it('keeps only a non-empty string', () => {
    expect(validateScopeSearch({ unit: A })).toEqual({ unit: A });
    expect(validateScopeSearch({ unit: '' })).toEqual({ unit: undefined });
    expect(validateScopeSearch({ unit: 42 })).toEqual({ unit: undefined });
  });
});
