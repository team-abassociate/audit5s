import { zoneDisplayLabel, zoneLabelFromCode } from './zone-code';

/**
 * A list of audits as a nested list: a heading per Unit, a heading per Zone under it, and the
 * audits under their Zone (owner, 2026-11-27). The reader finds the Unit first, then the Zone,
 * instead of reading every row for both.
 *
 * - **Units** keep the order the list already had (newest first, due first, …): a Unit sits
 *   where its first audit would have.
 * - **Zones** run in ascending order under their Unit, `1`, `1A`, `7`, then codes a Unit chose
 *   for itself (`BOILER`), then audits with no Zone yet (an assignment, or an audit whose Zone
 *   is still to be picked).
 * - **Audits** keep the list's order within their Zone. One that covers several Zones is listed
 *   under each: the reader asking "what happened in Zone 3" needs it there. `total` counts it
 *   once.
 *
 * Defined once, so the phone and the web nest the same way.
 */

/** One Zone of an item, as the item knows it. `name` is optional: lists often carry only codes. */
export interface GroupZone {
  /** What tells two Zones apart within the Unit: the Zone's id where known, else its code. */
  key: string;
  code: string;
  name?: string | null;
}

export interface AuditGroupItem {
  unitId: string;
  unitName: string;
  zones: readonly GroupZone[];
}

export interface AuditZoneGroup<T> {
  /** `NO_ZONE_KEY` for the items with no Zone. */
  key: string;
  label: string;
  items: T[];
}

export interface AuditUnitGroup<T> {
  unitId: string;
  unitName: string;
  /** How many items sit under this Unit, each counted once. */
  total: number;
  zones: AuditZoneGroup<T>[];
}

export const NO_ZONE_KEY = '';
export const NO_ZONE_LABEL = 'No Zone yet';

/** `Zone 7 — Press` with a name, `Zone 7` from a code alone, `BOILER` for a code a Unit chose. */
export function groupZoneLabel(zone: Pick<GroupZone, 'code' | 'name'>): string {
  if (zone.name?.trim()) return zoneDisplayLabel(zone.code, zone.name);
  const label = zoneLabelFromCode(zone.code);
  return label === null ? zone.code : `Zone ${label}`;
}

/** Ascending, as `zoneLabelsAscending` sorts: `1`, `1A`, `7`, then custom codes; no Zone last. */
function zoneOrder(a: { key: string; code: string }, b: { key: string; code: string }): number {
  if (a.key === NO_ZONE_KEY || b.key === NO_ZONE_KEY) return a.key === NO_ZONE_KEY ? 1 : -1;
  const labelA = zoneLabelFromCode(a.code);
  const labelB = zoneLabelFromCode(b.code);
  if ((labelA === null) !== (labelB === null)) return labelA === null ? 1 : -1;
  return (labelA ?? a.code).localeCompare(labelB ?? b.code, undefined, { numeric: true });
}

export function groupAuditsByUnitAndZone<T>(
  items: readonly T[],
  describe: (item: T) => AuditGroupItem,
): AuditUnitGroup<T>[] {
  const units = new Map<
    string,
    { unitId: string; unitName: string; total: number; zones: Map<string, { key: string; code: string; label: string; items: T[] }> }
  >();

  for (const item of items) {
    const { unitId, unitName, zones } = describe(item);
    let unit = units.get(unitId);
    if (!unit) units.set(unitId, (unit = { unitId, unitName, total: 0, zones: new Map() }));
    unit.total += 1;

    // One Zone listed twice on an item still lists the item once under it.
    const seen = new Set<string>();
    const own = zones.length > 0 ? zones : [{ key: NO_ZONE_KEY, code: '', name: null }];
    for (const zone of own) {
      if (seen.has(zone.key)) continue;
      seen.add(zone.key);
      let group = unit.zones.get(zone.key);
      if (!group) {
        const label = zone.key === NO_ZONE_KEY ? NO_ZONE_LABEL : groupZoneLabel(zone);
        unit.zones.set(zone.key, (group = { key: zone.key, code: zone.code, label, items: [] }));
      } else if (zone.name?.trim() && group.label === groupZoneLabel({ code: zone.code })) {
        // A later item knew the Zone's name; the heading takes it.
        group.label = groupZoneLabel(zone);
      }
      group.items.push(item);
    }
  }

  return [...units.values()].map((unit) => ({
    unitId: unit.unitId,
    unitName: unit.unitName,
    total: unit.total,
    zones: [...unit.zones.values()].sort(zoneOrder).map(({ key, label, items: zoneItems }) => ({ key, label, items: zoneItems })),
  }));
}

/**
 * The Zones of an audit as `GET /audits` sends them: `zoneIds` and `zoneCodes` side by side,
 * in audit order. `names` (Zone id → name) is used where the screen has the Unit's Zones.
 */
export function auditGroupZones(
  audit: { zoneIds?: readonly string[]; zoneCodes?: readonly string[] },
  names?: ReadonlyMap<string, string>,
): GroupZone[] {
  const codes = audit.zoneCodes ?? [];
  const ids = audit.zoneIds ?? [];
  return codes.map((code, index) => {
    const id = ids[index];
    return { key: id ?? code, code, name: id ? (names?.get(id) ?? null) : null };
  });
}

/**
 * The groups as one flat run of Zone sections, for a list that draws one level of section
 * (React Native's `SectionList`, a table body). The first Zone of each Unit carries the Unit,
 * so the Unit's heading is drawn above it.
 */
export function flattenAuditGroups<T>(
  groups: readonly AuditUnitGroup<T>[],
): Array<{ key: string; unit: { unitId: string; unitName: string; total: number } | null; zone: { key: string; label: string }; data: T[] }> {
  return groups.flatMap((unit) =>
    unit.zones.map((zone, index) => ({
      key: `${unit.unitId}:${zone.key}`,
      unit: index === 0 ? { unitId: unit.unitId, unitName: unit.unitName, total: unit.total } : null,
      zone: { key: zone.key, label: zone.label },
      data: zone.items,
    })),
  );
}
