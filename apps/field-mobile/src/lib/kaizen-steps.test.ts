import { describe, expect, it } from 'vitest';
import type { KaizenFields } from '@audit5s/contracts';
import { missingKaizenFields } from '@audit5s/domain';
import { formProgress, stepOf } from './kaizen-steps';

const COMPLETE: KaizenFields = {
  machine: '250T Press P-04',
  lineArea: 'Line 3',
  implementedOn: '2026-10-03',
  teamMembers: 'Sunita Kale, Rahul Pawar',
  theme: 'Die change cut from 42 to 18 min',
  problem5w1h: 'Changeover takes 42 minutes',
  countermeasure: 'Quick-release clamps',
  horizontalDeployment: false,
  benefits: '24 minutes a changeover',
  rootCause4m: 'Method: bolted clamps',
  ideaBy: 'Sunita Kale',
  implementedBy: 'Maintenance',
};

describe('formProgress', () => {
  it('an empty form: nothing done, every required step open, the photo steps optional', () => {
    const empty = formProgress({}, { before: false, after: false });
    expect(empty).toMatchObject({ done: 0, total: 12, requiredLeft: 8 });
    expect(empty.states[5]).toBe('optional');
    expect(empty.states[6]).toBe('optional');
  });

  it('says ready exactly when missingKaizenFields has nothing left, with or without photos', () => {
    const noPhotos = formProgress(COMPLETE, { before: false, after: false });
    expect(noPhotos.requiredLeft).toBe(0);
    expect(missingKaizenFields(COMPLETE)).toEqual([]);
    // Wastes, parameters and both photos are optional and empty: 8 of 12.
    expect(noPhotos.done).toBe(8);

    // A photo counts its step done.
    expect(formProgress(COMPLETE, { before: true, after: true }).done).toBe(10);
  });

  it('an optional step counts once something in it is filled', () => {
    expect(formProgress({ ...COMPLETE, wastes: ['MOTION'] }, { before: true, after: true }).done).toBe(11);
  });

  it('a step stays required while any one of its required boxes is empty', () => {
    const { states } = formProgress({ ...COMPLETE, lineArea: '  ' }, { before: true, after: true });
    expect(states[0]).toBe('required');
  });
});

describe('stepOf', () => {
  it('maps each missing item to the step that holds it', () => {
    expect(stepOf('problem5w1h')).toBe('problem');
    expect(stepOf('horizontalDeployment')).toBe('horizontal');
    expect(stepOf('implementedBy')).toBe('people');
  });
});
