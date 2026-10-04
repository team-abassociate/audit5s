import type { CorrectiveAction } from '@audit5s/contracts';
import { isOverdue, zoneDisplayLabel } from '@audit5s/domain';

/**
 * The corrective-action queue's sort and grouping (CA3, D3), over the list already fetched.
 * Pure, so the order a Coordinator works down is tested rather than eyeballed.
 *
 * ponytail: client-side over the API's first 200 rows; server paging is CA10 (S15e).
 */

export type SortKey = 'due' | 'age' | 'leader';
export type GroupKey = 'audit' | 'leader';

/** Who to chase: the leader it was assigned to, else its Zone's leader, typed or a user (D3). */
export type LeaderOf = (action: CorrectiveAction) => string | null;

const byText = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b);

export function sortActions(list: CorrectiveAction[], sort: SortKey, leaderOf: LeaderOf): CorrectiveAction[] {
  const due = (a: CorrectiveAction, b: CorrectiveAction) => byText(a.dueAt, b.dueAt);
  const compare =
    sort === 'age'
      ? (a: CorrectiveAction, b: CorrectiveAction) => a.openedAt.localeCompare(b.openedAt) || due(a, b)
      : sort === 'leader'
        ? (a: CorrectiveAction, b: CorrectiveAction) => byText(leaderOf(a), leaderOf(b)) || due(a, b)
        : due;
  return [...list].sort(compare);
}

export interface ActionGroup {
  key: string;
  /** The audit it came from, or the Zone and its leader. */
  auditId: string | null;
  zone: string | null;
  leader: string | null;
  list: CorrectiveAction[];
  overdue: number;
}

export interface UnitGroup {
  unitId: string;
  groups: ActionGroup[];
  overdue: number;
  total: number;
}

/**
 * Unit → audit, or Unit → Zone and leader. Worst first at both levels: the Unit and the
 * group carrying the most overdue work come first, so the page opens on what needs a call.
 */
export function groupActions(
  rows: CorrectiveAction[],
  { group, sort, leaderOf, now }: { group: GroupKey; sort: SortKey; leaderOf: LeaderOf; now: number },
): UnitGroup[] {
  const late = (action: CorrectiveAction) => isOverdue(action.status, action.dueAt, now);
  const units = new Map<string, Map<string, ActionGroup>>();
  for (const action of rows) {
    const groups = units.get(action.unitId) ?? new Map<string, ActionGroup>();
    const leader = leaderOf(action);
    const key = group === 'audit' ? action.auditId : `${action.zoneId}|${leader ?? ''}`;
    const entry = groups.get(key) ?? {
      key,
      auditId: group === 'audit' ? action.auditId : null,
      zone: group === 'leader' ? zoneDisplayLabel(action.zoneCode, action.zoneName) : null,
      leader: group === 'leader' ? leader : null,
      list: [],
      overdue: 0,
    };
    entry.list.push(action);
    if (late(action)) entry.overdue += 1;
    groups.set(key, entry);
    units.set(action.unitId, groups);
  }
  return [...units.entries()]
    .map(([unitId, groups]) => {
      const list = [...groups.values()]
        .map((entry) => ({ ...entry, list: sortActions(entry.list, sort, leaderOf) }))
        .sort(
          (a, b) =>
            b.overdue - a.overdue ||
            (group === 'audit'
              ? (b.list[0]!.auditCompletedAt ?? '').localeCompare(a.list[0]!.auditCompletedAt ?? '')
              : a.list[0]!.zoneCode.localeCompare(b.list[0]!.zoneCode, undefined, { numeric: true })),
        );
      return {
        unitId,
        groups: list,
        overdue: list.reduce((sum, entry) => sum + entry.overdue, 0),
        total: list.reduce((sum, entry) => sum + entry.list.length, 0),
      };
    })
    .sort((a, b) => b.overdue - a.overdue);
}

/** D3: the overdue items, by Zone and leader, most first — who to call, and about how many. */
export function overdueByLeader(
  rows: CorrectiveAction[],
  leaderOf: LeaderOf,
  now: number,
): { unitId: string; zone: string; leader: string | null; count: number }[] {
  const counts = new Map<string, { unitId: string; zone: string; leader: string | null; count: number }>();
  for (const action of rows) {
    if (!isOverdue(action.status, action.dueAt, now)) continue;
    const leader = leaderOf(action);
    const key = `${action.zoneId}|${leader ?? ''}`;
    const entry = counts.get(key) ?? {
      unitId: action.unitId,
      zone: zoneDisplayLabel(action.zoneCode, action.zoneName),
      leader,
      count: 0,
    };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.zone.localeCompare(b.zone));
}
