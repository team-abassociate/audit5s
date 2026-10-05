import type {
  CorrectiveAction,
  CorrectiveActionGroup,
  CorrectiveActionSort,
  CorrectiveActionSummary,
} from '@audit5s/contracts';
import { zoneDisplayLabel } from '@audit5s/domain';

/**
 * The corrective-action queue's grouping (CA3, D3, CA10). The server sorts and groups and
 * pages (`?sort=&group=`), and counts in `/corrective-actions/summary`; this only splits
 * the rows loaded so far into headed groups, in the order they arrived, and reads each
 * header's counts from the summary — so a header counts its whole group, not the part on
 * screen, and a group that runs onto the next page continues under the same header.
 */

export type SortKey = CorrectiveActionSort;
export type GroupKey = CorrectiveActionGroup;

/** Who to chase: the leader it was reassigned to, else its Zone's leader, typed or a user (D3). */
export const leaderOf = (action: CorrectiveAction): string | null =>
  action.assignedZoneLeaderName ?? action.zoneLeaderName ?? null;

export interface ActionGroup {
  key: string;
  /** The audit it came from, or the Zone and its leader. */
  auditId: string | null;
  zone: string | null;
  leader: string | null;
  list: CorrectiveAction[];
  total: number;
  overdue: number;
}

export interface UnitGroup {
  unitId: string;
  groups: ActionGroup[];
  total: number;
  overdue: number;
}

const zoneKey = (zoneId: string, leader: string | null) => `${zoneId}|${leader ?? ''}`;

/** Unit → audit, or Unit → Zone and leader, in arrival order; counts from the summary. */
export function groupActions(
  rows: CorrectiveAction[],
  group: GroupKey,
  summary: CorrectiveActionSummary | undefined,
): UnitGroup[] {
  const units = new Map<string, Map<string, ActionGroup>>();
  for (const action of rows) {
    const groups = units.get(action.unitId) ?? new Map<string, ActionGroup>();
    const leader = leaderOf(action);
    const key = group === 'audit' ? action.auditId : zoneKey(action.zoneId, leader);
    let entry = groups.get(key);
    if (!entry) {
      const counted =
        group === 'audit'
          ? summary?.byAudit.find((g) => g.unitId === action.unitId && g.auditId === action.auditId)
          : summary?.byZoneLeader.find((g) => g.unitId === action.unitId && zoneKey(g.zoneId, g.leader) === key);
      entry = {
        key,
        auditId: group === 'audit' ? action.auditId : null,
        zone: group === 'leader' ? zoneDisplayLabel(action.zoneCode, action.zoneName) : null,
        leader: group === 'leader' ? leader : null,
        list: [],
        total: counted?.total ?? 0,
        overdue: counted?.overdue ?? 0,
      };
      groups.set(key, entry);
    }
    entry.list.push(action);
    units.set(action.unitId, groups);
  }
  return [...units.entries()].map(([unitId, groups]) => {
    const unit = (summary?.byAudit ?? []).filter((g) => g.unitId === unitId);
    return {
      unitId,
      groups: [...groups.values()],
      total: unit.reduce((sum, g) => sum + g.total, 0),
      overdue: unit.reduce((sum, g) => sum + g.overdue, 0),
    };
  });
}

/** D3: the overdue items by Zone and leader, most first — who to call, and about how many. */
export function overdueByLeader(summary: CorrectiveActionSummary | undefined) {
  return (summary?.byZoneLeader ?? [])
    .filter((g) => g.overdue > 0)
    .map((g) => ({ unitId: g.unitId, zone: zoneDisplayLabel(g.zoneCode, g.zoneName), leader: g.leader, count: g.overdue }))
    .sort((a, b) => b.count - a.count || a.zone.localeCompare(b.zone));
}
