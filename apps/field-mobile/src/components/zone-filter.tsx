import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import type { Page, Zone } from '@audit5s/contracts';
import { api } from '../lib/api';
import { createThemedStyles } from '../lib/theme';
import { Button, CheckRow, HeaderAction, SectionHead } from './ui';

/**
 * Filtering a Coordinator's list by Zone (R-43) — the Actions tab and the Audits tab alike.
 *
 * The pieces, top to bottom as the screen wears them:
 *
 * - **The header button** says the filter's state even while it is closed: "Zone ▾" with
 *   nothing chosen, "Zones · 2" with two. It opens —
 * - **the sheet**, from the bottom edge where the thumb is: every Zone of the Unit, ticked
 *   or not, each with how many rows it holds on the current board. Ticking applies at once,
 *   so the list behind the scrim is already the answer when the sheet closes.
 * - **The chips** under the board switch, one per chosen Zone, each removable on its own —
 *   the filter is visible where the list is, not only up in the header.
 * - **The groups.** A filtered list is grouped under a head per Zone, in the Unit's Zone
 *   order, newest first within each. An audit covering two chosen Zones is listed under both:
 *   the reader is asking "what happened in Zone 3", and that audit is part of the answer.
 *
 * Nothing chosen means no filter: the list is the board as it always was, ungrouped.
 */

export interface ZoneOption {
  id: string;
  code: string;
  name: string;
}

export function zoneTitle(zone: Pick<ZoneOption, 'code' | 'name'>): string {
  return `Zone ${zone.code} — ${zone.name}`;
}

/** The Unit's Zones in its own order — the same query My Unit makes, so usually cached. */
export function useUnitZones(unitId: string | undefined): ZoneOption[] {
  const zones = useQuery({
    queryKey: ['zones', unitId],
    queryFn: () => api.get<Page<Zone>>(`/units/${unitId}/zones?limit=200`),
    enabled: unitId !== undefined,
  });
  return useMemo(
    () =>
      (zones.data?.data ?? [])
        .map((zone) => ({ id: zone.id, code: zone.code, name: zone.name }))
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    [zones.data],
  );
}

/** The filter's state and its three views, wired once per screen. */
export function useZoneFilter() {
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  return {
    selected,
    setSelected,
    open,
    show: () => setOpen(true),
    hide: () => setOpen(false),
    active: selected.length > 0,
  };
}

export function ZoneFilterButton({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <HeaderAction
      testID="zone-filter"
      title={count === 0 ? 'Zone ▾' : `Zones · ${count}`}
      accessibilityLabel={count === 0 ? 'Filter by zone' : `Filtered to ${count} zone${count === 1 ? '' : 's'}. Change`}
      onPress={onPress}
    />
  );
}

export function ZoneFilterSheet({
  visible,
  zones,
  selected,
  counts,
  onChange,
  onClose,
}: {
  visible: boolean;
  zones: readonly ZoneOption[];
  selected: readonly string[];
  /** Rows per Zone on the current board, printed beside each. */
  counts: ReadonlyMap<string, number>;
  onChange: (selected: string[]) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const toggle = (zoneId: string, on: boolean) =>
    // Kept in the Unit's Zone order, whatever order they were ticked in, so the groups are.
    onChange(zones.map((zone) => zone.id).filter((id) => (id === zoneId ? on : selected.includes(id))));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: 14 + insets.bottom, maxHeight: height * 0.75 }]}>
        <Text style={styles.title} accessibilityRole="header">
          Filter by zone
        </Text>
        <ScrollView contentContainerStyle={styles.list}>
          {zones.length === 0 ? <Text style={styles.empty}>This Unit has no Zones yet.</Text> : null}
          {zones.map((zone) => (
            <CheckRow
              key={zone.id}
              label={zoneTitle(zone)}
              value={String(counts.get(zone.id) ?? 0)}
              checked={selected.includes(zone.id)}
              onChange={(on) => toggle(zone.id, on)}
            />
          ))}
        </ScrollView>
        <View style={styles.actions}>
          <View style={styles.action}>
            <Button title="Show all" variant="secondary" disabled={selected.length === 0} onPress={() => onChange([])} />
          </View>
          <View style={styles.action}>
            <Button title="Done" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * One removable chip per chosen Zone, under the board switch. Nothing when unfiltered.
 *
 * The chip says the Zone's code alone — "Z-03 ✕" — so three or four fit on one line; the
 * group heads below name each Zone in full, and a screen reader hears the full name. It is
 * drawn small and reached through `hitSlop`, which keeps the 48dp target.
 */
export function ZoneFilterChips({
  zones,
  selected,
  onChange,
}: {
  zones: readonly ZoneOption[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
}) {
  const styles = useStyles();
  if (selected.length === 0) return null;
  const chosen = zones.filter((zone) => selected.includes(zone.id));
  return (
    <View style={styles.chips}>
      {chosen.map((zone) => (
        <Pressable
          key={zone.id}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${zoneTitle(zone)} from the filter`}
          hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
          onPress={() => onChange(selected.filter((id) => id !== zone.id))}
          style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
        >
          <Text style={styles.chipText} numberOfLines={1}>
            {zone.code}
          </Text>
          <Text style={styles.chipX}>✕</Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * The filtered list, grouped: one group per chosen Zone that has rows, in the Unit's Zone
 * order, rows newest first within it. `zonesOf` says which Zones a row belongs to — one for
 * a corrective action, any number for an audit.
 */
export function groupByZone<T>(
  items: readonly T[],
  zones: readonly ZoneOption[],
  selected: readonly string[],
  zonesOf: (item: T) => readonly string[],
  timeOf: (item: T) => number,
): Array<{ zone: ZoneOption; data: T[] }> {
  return zones
    .filter((zone) => selected.includes(zone.id))
    .map((zone) => ({
      zone,
      data: items.filter((item) => zonesOf(item).includes(zone.id)).sort((a, b) => timeOf(b) - timeOf(a)),
    }))
    .filter((group) => group.data.length > 0);
}

/** How many rows each Zone holds, for the sheet. */
export function countByZone<T>(items: readonly T[], zonesOf: (item: T) => readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const zoneId of new Set(zonesOf(item))) counts.set(zoneId, (counts.get(zoneId) ?? 0) + 1);
  }
  return counts;
}

/** A group's head: which Zone this is, and how many rows it holds. */
export function ZoneGroupHead({ zone, count, noun }: { zone: ZoneOption; count: number; noun: [string, string] }) {
  const styles = useStyles();
  return (
    <View style={styles.groupHead}>
      <SectionHead title={zoneTitle(zone)} description={`${count} ${count === 1 ? noun[0] : noun[1]}`} />
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.color.hard },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.color.tile,
    borderTopWidth: 2,
    borderTopColor: theme.color.edge,
    padding: theme.space.md,
    gap: theme.space.md,
  },
  title: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.32,
  },
  list: { gap: theme.space.sm },
  empty: { fontFamily: theme.family.regular, fontSize: theme.font.sm, color: theme.color.ink2 },
  actions: { flexDirection: 'row', gap: theme.space.sm },
  action: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, marginBottom: theme.space.md },
  chip: {
    height: 28,
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    borderWidth: 1.5,
    borderColor: theme.color.accent,
    backgroundColor: theme.color.accentSoft,
  },
  chipPressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
  chipText: {
    flexShrink: 1,
    fontFamily: theme.family.bold,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.color.ink,
  },
  chipX: { fontFamily: theme.family.bold, fontSize: 11, color: theme.color.ink2 },
  groupHead: { marginTop: theme.space.sm, backgroundColor: theme.color.board },
}));
