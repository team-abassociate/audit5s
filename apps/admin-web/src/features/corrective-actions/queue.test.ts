import { describe, expect, it } from 'vitest';
import type { CorrectiveAction } from '@audit5s/contracts';
import { groupActions, overdueByLeader, sortActions } from './queue';

const NOW = Date.parse('2026-10-04T06:00:00Z');

function action(id: string, overrides: Partial<CorrectiveAction> = {}): CorrectiveAction {
  return {
    id,
    unitId: 'u1',
    auditId: 'a1',
    zoneId: 'z1',
    zoneCode: 'Z-01',
    zoneName: 'Zone 1',
    status: 'OPEN',
    dueAt: '2026-10-10T00:00:00Z',
    openedAt: '2026-09-30T00:00:00Z',
    assignedZoneLeaderName: null,
    auditCompletedAt: '2026-09-30T00:00:00Z',
    ...overrides,
  } as CorrectiveAction;
}

const typed: Record<string, string> = { z1: 'Amol Khairnar', z2: 'Bina Rao' };
const leaderOf = (a: CorrectiveAction) => a.assignedZoneLeaderName ?? typed[a.zoneId] ?? null;

describe('corrective-action queue', () => {
  it('sorts by due date with undated last, by age oldest first, and by leader A to Z', () => {
    const list = [
      action('late', { dueAt: '2026-10-01T00:00:00Z', openedAt: '2026-09-20T00:00:00Z', zoneId: 'z2' }),
      action('none', { dueAt: null, openedAt: '2026-09-01T00:00:00Z', zoneId: 'z9' }),
      action('soon', { dueAt: '2026-10-05T00:00:00Z' }),
    ];
    expect(sortActions(list, 'due', leaderOf).map((a) => a.id)).toEqual(['late', 'soon', 'none']);
    expect(sortActions(list, 'age', leaderOf).map((a) => a.id)).toEqual(['none', 'late', 'soon']);
    expect(sortActions(list, 'leader', leaderOf).map((a) => a.id)).toEqual(['soon', 'late', 'none']);
  });

  it('groups by Zone and leader, the group with most overdue first, and a reassigned item apart', () => {
    const rows = [
      action('1', { zoneId: 'z1' }),
      action('2', { zoneId: 'z2', zoneCode: 'Z-02', zoneName: 'Zone 2', dueAt: '2026-10-01T00:00:00Z' }),
      action('3', { zoneId: 'z1', assignedZoneLeaderName: 'Reassigned' }),
    ];
    const [unit] = groupActions(rows, { group: 'leader', sort: 'due', leaderOf, now: NOW });
    expect(unit!.overdue).toBe(1);
    expect(unit!.groups.map((g) => [g.zone, g.leader, g.list.length])).toEqual([
      ['Zone 2', 'Bina Rao', 1],
      ['Zone 1', 'Amol Khairnar', 1],
      ['Zone 1', 'Reassigned', 1],
    ]);
  });

  it('names who to chase for overdue items only, a Zone without a leader as null', () => {
    const rows = [
      action('1', { dueAt: '2026-10-01T00:00:00Z' }),
      action('2', { dueAt: '2026-10-02T00:00:00Z' }),
      action('3', { dueAt: '2026-10-02T00:00:00Z', zoneId: 'z9', zoneCode: 'Z-09', zoneName: 'Zone 9' }),
      action('4', { dueAt: '2026-10-02T00:00:00Z', status: 'VERIFIED' }),
    ];
    expect(overdueByLeader(rows, leaderOf, NOW)).toEqual([
      { unitId: 'u1', zone: 'Zone 1', leader: 'Amol Khairnar', count: 2 },
      { unitId: 'u1', zone: 'Zone 9', leader: null, count: 1 },
    ]);
  });
});
