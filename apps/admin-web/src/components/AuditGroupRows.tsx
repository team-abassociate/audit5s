import { Fragment, type ReactNode } from 'react';
import { auditGroupZones, flattenAuditGroups, groupAuditsByUnitAndZone } from '@audit5s/domain';

/**
 * A table's body as a nested list of audits (owner, 2026-11-27): a `.gb-group` row per Unit,
 * a lighter `.gb-group--zone` row per Zone a step in, and the audits under their Zone. The
 * grouping is `groupAuditsByUnitAndZone` in `packages/domain`, shared with the phone.
 *
 * Units keep the order the rows came in, Zones run in ascending order, and an audit covering
 * two Zones is under both: `renderRow` is given a key that tells the two apart. Each row should
 * carry `gb-row--nested` so its first cell steps in under the Zone.
 */
export function AuditGroupRows<
  T extends { id: string; unitId: string; unitName: string; zoneIds?: string[]; zoneCodes?: string[] },
>({
  audits,
  columns,
  showUnit = true,
  renderRow,
}: {
  audits: readonly T[];
  /** How many columns the table has, for the heading rows to span. */
  columns: number;
  /** False where every row is one Unit's: only the Zones are headings. */
  showUnit?: boolean;
  renderRow: (audit: T, key: string) => ReactNode;
}) {
  const sections = flattenAuditGroups(
    groupAuditsByUnitAndZone(audits, (audit) => ({
      unitId: audit.unitId,
      unitName: audit.unitName,
      zones: auditGroupZones(audit),
    })),
  );
  return (
    <>
      {sections.map((section) => (
        <Fragment key={section.key}>
          {showUnit && section.unit ? (
            <tr className="gb-group">
              <td colSpan={columns}>
                <span className="gb-group-title">{section.unit.unitName}</span>
                <span className="gb-group-meta">{counted(section.unit.total)}</span>
              </td>
            </tr>
          ) : null}
          <tr className="gb-group gb-group--zone">
            <td colSpan={columns}>
              <span className="gb-group-title">{section.zone.label}</span>
              <span className="gb-group-meta">{counted(section.data.length)}</span>
            </td>
          </tr>
          {section.data.map((audit) => renderRow(audit, `${section.key}:${audit.id}`))}
        </Fragment>
      ))}
    </>
  );
}

function counted(count: number): string {
  return `${count} ${count === 1 ? 'audit' : 'audits'}`;
}
