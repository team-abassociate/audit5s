import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { AuditUnitGroup } from '@audit5s/domain';
import { createThemedStyles } from '../lib/theme';
import { SectionHead } from './ui';

/**
 * A list of audits drawn as a nested list (owner, 2026-11-27): the Unit as a heading, each of
 * its Zones as a smaller heading under it, and the audits under their Zone, all on one rule
 * down the left so a Zone's audits read as belonging to it. The grouping itself is
 * `groupAuditsByUnitAndZone` in `packages/domain`, shared with the web.
 *
 * `showUnit` is false where every row is the same Unit (a Coordinator, a Unit's own page):
 * the Unit is said once elsewhere, and only the Zones are headings.
 *
 * Two ways to draw it: `AuditGroupList` inside a ScrollView or a card, and `GroupHeads` +
 * `InZone` for a `SectionList` fed by `flattenAuditGroups`.
 */

export type Noun = readonly [one: string, many: string];

const counted = (count: number, [one, many]: Noun) => `${count} ${count === 1 ? one : many}`;

/** The Unit's heading: its name, and how many items are under it, each counted once. */
export function UnitGroupHead({ name, total, noun }: { name: string; total: number; noun: Noun }) {
  const styles = useStyles();
  return (
    <View style={styles.unitHead}>
      <SectionHead title={name} description={counted(total, noun)} />
    </View>
  );
}

/** The Zone's heading, a step in from its Unit, on the rule its audits hang from. */
export function ZoneGroupLabel({ label, count, noun }: { label: string; count: number; noun: Noun }) {
  const styles = useStyles();
  return (
    <View style={[styles.rule, styles.zoneHead]} accessibilityRole="header">
      <Text style={styles.zoneTitle}>{label}</Text>
      <Text style={styles.zoneCount}>{counted(count, noun)}</Text>
    </View>
  );
}

/** One row under a Zone heading, on the same rule. */
export function InZone({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.rule}>{children}</View>;
}

/** A `SectionList` section head for `flattenAuditGroups`: the Unit above its first Zone. */
export function GroupHeads({
  section,
  showUnit,
  noun,
}: {
  section: { unit: { unitName: string; total: number } | null; zone: { label: string }; data: readonly unknown[] };
  showUnit: boolean;
  noun: Noun;
}) {
  return (
    <>
      {showUnit && section.unit ? <UnitGroupHead name={section.unit.unitName} total={section.unit.total} noun={noun} /> : null}
      <ZoneGroupLabel label={section.zone.label} count={section.data.length} noun={noun} />
    </>
  );
}

/** The whole nested list, for a screen that is a ScrollView rather than a SectionList. */
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
          {showUnit ? <UnitGroupHead name={unit.unitName} total={unit.total} noun={noun} /> : null}
          {unit.zones.map((zone) => (
            <View key={zone.key}>
              <ZoneGroupLabel label={zone.label} count={zone.items.length} noun={noun} />
              {zone.items.map((item) => (
                <InZone key={keyOf(item)}>{renderItem(item)}</InZone>
              ))}
            </View>
          ))}
        </View>
      ))}
    </>
  );
}

const useStyles = createThemedStyles((theme) => ({
  unitHead: { marginTop: theme.space.md },
  // The nesting: a step in, and a rule down the left from the Zone's heading to its last row.
  rule: {
    marginLeft: theme.space.xs,
    paddingLeft: theme.space.md,
    borderLeftWidth: 2,
    borderLeftColor: theme.color.rule,
  },
  zoneHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.sm,
    paddingTop: theme.space.xs,
    paddingBottom: theme.space.sm,
  },
  zoneTitle: {
    flexShrink: 1,
    fontFamily: theme.family.bold,
    fontSize: theme.font.base,
    color: theme.color.ink,
  },
  zoneCount: {
    fontFamily: theme.family.regular,
    fontSize: theme.font.sm,
    color: theme.color.ink2,
    fontVariant: ['tabular-nums'],
  },
}));
