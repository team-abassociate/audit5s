import { zoneDisplayLabel, zoneLabelFromCode } from './zone-code';

/**
 * A list of audits grouped under a heading per Unit, each audit once, its Zones worn as tags
 * on the audit itself (owner, 2026-11-27, chosen over Zone headings so no audit is listed
 * twice). The reader finds the Unit first, then reads the Zone tags.
 *
 * - **Units** keep the order the list already had (newest first, due first, …): a Unit sits
 *   where its first audit would have.
 * - **Audits** keep the list's order within their Unit.
 * - **Zone tags** run in ascending order, `1`, `1A`, `7`, then codes a Unit chose for itself.
 *
 * Defined once, so the phone and the web group and name the same way.
 */

export interface AuditUnitGroup<T> {
  unitId: string;
  unitName: string;
  items: T[];
}

export function groupAuditsByUnit<T>(
  items: readonly T[],
  unitOf: (item: T) => { unitId: string; unitName: string },
): AuditUnitGroup<T>[] {
  const units = new Map<string, AuditUnitGroup<T>>();
  for (const item of items) {
    const { unitId, unitName } = unitOf(item);
    let unit = units.get(unitId);
    if (!unit) units.set(unitId, (unit = { unitId, unitName, items: [] }));
    unit.items.push(item);
  }
  return [...units.values()];
}

/** One Zone as a tag names it. `name` is optional: many lists carry only the code. */
export interface TagZone {
  code: string;
  name?: string | null;
}

/** `Zone 7 — Press` with a name, `Zone 7` from a code alone, `BOILER` for a code a Unit chose. */
export function zoneTagLabel(zone: TagZone): string {
  if (zone.name?.trim()) return zoneDisplayLabel(zone.code, zone.name);
  const label = zoneLabelFromCode(zone.code);
  return label === null ? zone.code : `Zone ${label}`;
}

/** An audit's Zone tags: each Zone once, in ascending order, labelled as everywhere else. */
export function zoneTags(zones: readonly TagZone[]): string[] {
  const byCode = new Map<string, TagZone>();
  for (const zone of zones) {
    const known = byCode.get(zone.code);
    if (!known || (!known.name?.trim() && zone.name?.trim())) byCode.set(zone.code, zone);
  }
  return [...byCode.values()]
    .sort((a, b) => {
      const labelA = zoneLabelFromCode(a.code);
      const labelB = zoneLabelFromCode(b.code);
      if ((labelA === null) !== (labelB === null)) return labelA === null ? 1 : -1;
      return (labelA ?? a.code).localeCompare(labelB ?? b.code, undefined, { numeric: true });
    })
    .map(zoneTagLabel);
}

/**
 * The Zone tags of an audit as `GET /audits` sends it: `zoneIds` and `zoneCodes` side by side.
 * `names` (Zone id → name) is used where the screen has the Unit's Zones.
 */
export function auditZoneTags(
  audit: { zoneIds?: readonly string[]; zoneCodes?: readonly string[] },
  names?: ReadonlyMap<string, string>,
): string[] {
  const ids = audit.zoneIds ?? [];
  return zoneTags((audit.zoneCodes ?? []).map((code, index) => ({ code, name: names?.get(ids[index] ?? '') ?? null })));
}
