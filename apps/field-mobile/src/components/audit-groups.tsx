import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { AuditUnitGroup } from '@audit5s/domain';
import { createThemedStyles } from '../lib/theme';
import { SectionHead } from './ui';

/**
 * A list of audits grouped by Unit (owner, 2026-11-27): the Unit as a heading, each of its
 * audits once beneath it on one rule down the left, and every audit wearing its Zones as tags
 * (`ZoneTags`). The grouping itself is `groupAuditsByUnit` in `packages/domain`, shared with
 * the web; the tags are `zoneTags` / `auditZoneTags`.
 *
 * `showUnit` is false where every row is the same Unit (a Coordinator): the Unit is said once
 * elsewhere, and the rows stand without a heading.
 *
 * Two ways to draw it: `AuditGroupList` inside a ScrollView or a card, and `unitSections` +
 * `UnitSectionHead` + `InUnit` for a `SectionList`.
 */

export type Noun = readonly [one: string, many: string];

const counted = (count: number, [one, many]: Noun) => `${count} ${count === 1 ? one : many}`;

/** The Unit's heading: its name, and how many items are under it. */
export function UnitGroupHead({ name, count, noun }: { name: string; count: number; noun: Noun }) {
  const styles = useStyles();
  return (
    <View style={styles.unitHead}>
      <SectionHead title={name} description={counted(count, noun)} />
    </View>
  );
}

/** One row under its Unit's heading, a step in, on the rule down the left. */
export function InUnit({ children, nested = true }: { children: ReactNode; nested?: boolean }) {
  const styles = useStyles();
  return nested ? <View style={styles.rule}>{children}</View> : <>{children}</>;
}

/** An audit's Zones, one tag each, in ascending order. Nothing when it has none yet. */
export function ZoneTags({ tags }: { tags: readonly string[] }) {
  const styles = useStyles();
  if (tags.length === 0) return null;
  return (
    <View style={styles.tags} accessibilityLabel={tags.join(', ')}>
      {tags.map((tag) => (
        <Text key={tag} style={styles.tag}>
          {tag}
        </Text>
      ))}
    </View>
  );
}

/** The groups as `SectionList` sections, one per Unit. */
export function unitSections<T>(groups: readonly AuditUnitGroup<T>[]) {
  return groups.map((unit) => ({ key: unit.unitId, unitName: unit.unitName, data: unit.items }));
}

/** A `SectionList` section head for `unitSections`. */
export function UnitSectionHead({
  section,
  showUnit,
  noun,
}: {
  section: { unitName: string; data: readonly unknown[] };
  showUnit: boolean;
  noun: Noun;
}) {
  return showUnit ? <UnitGroupHead name={section.unitName} count={section.data.length} noun={noun} /> : null;
}

/** The whole grouped list, for a screen that is a ScrollView rather than a SectionList. */
export function AuditGroupList<T>({
  groups,
  showUnit,
  noun,
  keyOf,
  renderItem,
}: {
  groups: readonly AuditUnitGroup<T>[];
  showUnit: boolean;
  noun: Noun;
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
}) {
  return (
    <>
      {groups.map((unit) => (
        <View key={unit.unitId}>
          {showUnit ? <UnitGroupHead name={unit.unitName} count={unit.items.length} noun={noun} /> : null}
          {unit.items.map((item) => (
            <InUnit key={keyOf(item)} nested={showUnit}>
              {renderItem(item)}
            </InUnit>
          ))}
        </View>
      ))}
    </>
  );
}

const useStyles = createThemedStyles((theme) => ({
  unitHead: { marginTop: theme.space.md },
  // The grouping: a step in, and a rule down the left from the Unit's heading to its last row.
  rule: {
    marginLeft: theme.space.xs,
    paddingLeft: theme.space.md,
    borderLeftWidth: 2,
    borderLeftColor: theme.color.rule,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: theme.space.xs },
  // A neutral chip with a rule edge: a Zone is a place, never a score (LEDGER.md rule 4).
  tag: {
    overflow: 'hidden',
    backgroundColor: theme.color.chip,
    borderWidth: 1,
    borderColor: theme.color.rule,
    borderRadius: theme.radius.chip,
    paddingHorizontal: theme.space.sm,
    paddingVertical: 3,
    fontFamily: theme.family.bold,
    fontSize: 12.5,
    color: theme.color.ink,
  },
}));
