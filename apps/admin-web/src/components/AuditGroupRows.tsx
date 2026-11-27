import { Fragment, type ReactNode } from 'react';
import { groupAuditsByUnit } from '@audit5s/domain';

/**
 * A table's body grouped by Unit (owner, 2026-11-27): a `.gb-group` row per Unit, and its
 * audits beneath it, each once. Each row should carry `gb-row--nested` so its first cell steps
 * in under the Unit, and wear its Zones as `ZoneTags`. The grouping is `groupAuditsByUnit` in
 * `packages/domain`, shared with the phone; Units keep the order the rows came in.
 */
export function AuditGroupRows<T extends { id: string; unitId: string; unitName: string }>({
  audits,
  columns,
  renderRow,
}: {
  audits: readonly T[];
  /** How many columns the table has, for the heading rows to span. */
  columns: number;
  renderRow: (audit: T) => ReactNode;
}) {
  return (
    <>
      {groupAuditsByUnit(audits, (audit) => audit).map((unit) => (
        <Fragment key={unit.unitId}>
          <tr className="gb-group">
            <td colSpan={columns}>
              <span className="gb-group-title">{unit.unitName}</span>
              <span className="gb-group-meta">
                {unit.items.length} {unit.items.length === 1 ? 'audit' : 'audits'}
              </span>
            </td>
          </tr>
          {unit.items.map(renderRow)}
        </Fragment>
      ))}
    </>
  );
}

/** An audit's Zones, one tag each (`zoneTags` / `auditZoneTags`). Nothing when it has none. */
export function ZoneTags({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="gb-zone-tags">
      {tags.map((tag) => (
        <span key={tag} className="gb-zone-tag">
          {tag}
        </span>
      ))}
    </span>
  );
}
