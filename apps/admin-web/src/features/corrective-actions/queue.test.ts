import { describe, expect, it } from 'vitest';
import type { CorrectiveAction, CorrectiveActionSummary } from '@audit5s/contracts';
import { groupActions, overdueByLeader } from './queue';

function action(id: string, overrides: Partial<CorrectiveAction> = {}): CorrectiveAction {
  return {
    id,
    unitId: 'u1',
    auditId: 'a1',
    zoneId: 'z1',
    zoneCode: 'Z-01',
    zoneName: 'Zone 1',
    status: 'OPEN',
    assignedZoneLeaderName: null,
    zoneLeaderName: 'Amol Khairnar',
    ...overrides,
  } as CorrectiveAction;
}

const summary = {
  byAudit: [{ unitId: 'u1', auditId: 'a1', total: 5, overdue: 2 }],
  byZoneLeader: [
    { unitId: 'u1', zoneId: 'z1', zoneCode: 'Z-01', zoneName: 'Zone 1', leader: 'Amol Khairnar', total: 3, overdue: 2 },
    { unitId: 'u1', zoneId: 'z1', zoneCode: 'Z-01', zoneName: 'Zone 1', leader: 'Reassigned', total: 1, overdue: 0 },
    { unitId: 'u1', zoneId: 'z9', zoneCode: 'Z-09', zoneName: 'Zone 9', leader: null, total: 1, overdue: 1 },
  ],
} as unknown as CorrectiveActionSummary;

describe('corrective-action queue', () => {
  it('keeps the server’s order, one header per group, counted over the whole group', () => {
    // Page one ended inside Zone 1's group; page two continues it.
    const rows = [
      action('1'),
      action('2'),
      action('3'),
      action('4', { assignedZoneLeaderName: 'Reassigned' }),
      action('5', { zoneId: 'z9', zoneCode: 'Z-09', zoneName: 'Zone 9', zoneLeaderName: null }),
    ];
    const [unit] = groupActions(rows, 'leader', summary);
    expect(unit!.groups.map((g) => [g.zone, g.leader, g.list.length, g.total, g.overdue])).toEqual([
      ['Zone 1', 'Amol Khairnar', 3, 3, 2],
      ['Zone 1', 'Reassigned', 1, 1, 0],
      ['Zone 9', null, 1, 1, 1],
    ]);
    expect([unit!.total, unit!.overdue]).toEqual([5, 2]);
  });

  it('counts a group from the summary even when only part of it is loaded', () => {
    const [unit] = groupActions([action('1')], 'audit', summary);
    expect(unit!.groups[0]).toMatchObject({ auditId: 'a1', total: 5, overdue: 2 });
    expect(unit!.groups[0]!.list).toHaveLength(1);
  });

  it('names who to chase for overdue groups only, most first, a Zone without a leader as null', () => {
    expect(overdueByLeader(summary)).toEqual([
      { unitId: 'u1', zone: 'Zone 1', leader: 'Amol Khairnar', count: 2 },
      { unitId: 'u1', zone: 'Zone 9', leader: null, count: 1 },
    ]);
  });
});
