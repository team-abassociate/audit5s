import { describe, expect, it } from 'vitest';
import { outOfScopeOutcome } from './scope';

describe('outOfScopeOutcome (AZ-3)', () => {
  it('hides existence on reads so object IDs cannot be probed', () => {
    expect(outOfScopeOutcome('read')).toBe('NOT_FOUND');
  });

  it('reports forbidden on writes, where the actor can already see the resource', () => {
    expect(outOfScopeOutcome('write')).toBe('FORBIDDEN');
  });
});
