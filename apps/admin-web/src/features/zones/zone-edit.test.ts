import { describe, expect, it } from 'vitest';
import type { User, Zone } from '@audit5s/contracts';
import {
  changedZoneFields,
  editZoneDefaults,
  leaderAccountOptions,
  TYPED_LEADER,
  typedLeaderOf,
} from './zone-edit';

const LEADER_ID = '00000000-0000-7000-8000-000000000001';
const OTHER_ID = '00000000-0000-7000-8000-000000000002';

function zone(overrides: Partial<Zone> = {}): Zone {
  return {
    id: '00000000-0000-7000-8000-0000000000aa',
    unitId: '00000000-0000-7000-8000-0000000000bb',
    code: 'Z-05',
    name: 'Zone 5',
    description: 'fdsa',
    departmentHint: null,
    defaultChecklistTemplateId: null,
    zoneLeaderId: null,
    zoneLeaderName: null,
    sortOrder: 5,
    version: 1,
    archivedAt: null,
    createdAt: '2026-09-23T07:47:28.457Z',
    updatedAt: '2026-09-23T07:47:28.457Z',
    ...overrides,
  };
}

function leader(id: string, fullName: string, loginId: string): User {
  return { id, fullName, loginId } as User;
}

describe('editZoneDefaults', () => {
  it('opens a typed leader on the typed name, not on Unassigned', () => {
    const typed = zone({ zoneLeaderName: 'fsda' });
    expect(typedLeaderOf(typed)).toBe('fsda');
    expect(editZoneDefaults(typed).zoneLeaderId).toBe(TYPED_LEADER);
  });

  it('opens an account leader on the account', () => {
    const assigned = zone({ zoneLeaderId: LEADER_ID, zoneLeaderName: 'Zoe Leader' });
    expect(typedLeaderOf(assigned)).toBeNull();
    expect(editZoneDefaults(assigned).zoneLeaderId).toBe(LEADER_ID);
  });

  it('opens a Zone with no leader on Unassigned', () => {
    expect(editZoneDefaults(zone()).zoneLeaderId).toBe('');
  });
});

describe('leaderAccountOptions', () => {
  it('keeps the current account when the list does not have it', () => {
    const assigned = zone({ zoneLeaderId: LEADER_ID, zoneLeaderName: 'Meena Patil' });
    const options = leaderAccountOptions(assigned, [leader(OTHER_ID, 'Ravi Kumar', 'RA0905')]);
    expect(options).toEqual([
      { value: LEADER_ID, label: 'Meena Patil' },
      { value: OTHER_ID, label: 'Ravi Kumar (RA0905)' },
    ]);
  });

  it('does not duplicate the current account', () => {
    const assigned = zone({ zoneLeaderId: LEADER_ID, zoneLeaderName: 'Zoe Leader' });
    const options = leaderAccountOptions(assigned, [leader(LEADER_ID, 'Zoe Leader', 'ZL0904')]);
    expect(options).toEqual([{ value: LEADER_ID, label: 'Zoe Leader (ZL0904)' }]);
  });
});

describe('changedZoneFields', () => {
  it('sends only the description when only the description changed (typed leader kept)', () => {
    const initial = editZoneDefaults(zone({ zoneLeaderName: 'fsda' }));
    const body = changedZoneFields(
      { ...initial, description: 'Paint line' },
      initial,
      { description: true },
    );
    expect(body).toEqual({ description: 'Paint line' });
  });

  it('sends only the description when only the description changed (account kept)', () => {
    const initial = editZoneDefaults(zone({ zoneLeaderId: LEADER_ID }));
    const body = changedZoneFields({ ...initial, description: '' }, initial, { description: true });
    expect(body).toEqual({ description: '' });
    expect(body).not.toHaveProperty('zoneLeaderId');
  });

  it('sends an explicit null when the user picks Unassigned', () => {
    const initial = editZoneDefaults(zone({ zoneLeaderId: LEADER_ID }));
    const body = changedZoneFields({ ...initial, zoneLeaderId: '' }, initial, {
      zoneLeaderId: true,
    });
    expect(body).toEqual({ zoneLeaderId: null });
  });

  it('sends the account when the user replaces a typed leader', () => {
    const initial = editZoneDefaults(zone({ zoneLeaderName: 'fsda' }));
    const body = changedZoneFields({ ...initial, zoneLeaderId: OTHER_ID }, initial, {
      zoneLeaderId: true,
    });
    expect(body).toEqual({ zoneLeaderId: OTHER_ID });
  });

  it('never sends the typed-leader placeholder', () => {
    const initial = editZoneDefaults(zone({ zoneLeaderName: 'fsda' }));
    // Picked another option, then went back: dirty in the form, unchanged in value.
    expect(changedZoneFields(initial, initial, { zoneLeaderId: true })).toBeNull();
  });

  it('returns null when nothing changed, so no empty PATCH is sent', () => {
    const initial = editZoneDefaults(zone({ zoneLeaderName: 'fsda' }));
    expect(changedZoneFields(initial, initial, {})).toBeNull();
  });

  it('clears the default checklist with an explicit null', () => {
    const initial = editZoneDefaults(zone({ defaultChecklistTemplateId: OTHER_ID }));
    const body = changedZoneFields({ ...initial, defaultChecklistTemplateId: '' }, initial, {
      defaultChecklistTemplateId: true,
    });
    expect(body).toEqual({ defaultChecklistTemplateId: null });
  });
});
