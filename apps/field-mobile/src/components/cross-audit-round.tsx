import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { DateTimePickerAndroid } from '../lib/date-dialog';
import type { CrossAuditRound, CrossAuditZoneState } from '@audit5s/contracts';
import { formatDayMonth, istDateKey, zoneDisplayLabel } from '@audit5s/domain';
import { api, problemMessage } from '../lib/api';
import { isOverdue } from '../lib/cross-audit-call';
import { createThemedStyles, useTheme } from '../lib/theme';
import { Button, Card, CardHeader, CheckRow, Chip, Data, Icon } from './ui';
import { useUnitZones } from './zone-filter';

/**
 * A called cross audit as the Coordinator sees it (0051, owner 2026-10-14): one call of one
 * Zone or many is one "cross-zonal audit", a card on every board of the Audits tab. Each
 * board opens it on its own Zones — Assigned on those nobody has started, Active on those
 * under way, Completed on those done.
 */

export type RoundBoard = 'ASSIGNED' | 'ACTIVE' | 'DONE';

/** Which Zones each board shows. */
export const BOARD_STATE: Record<RoundBoard, CrossAuditZoneState> = {
  ASSIGNED: 'NOT_STARTED',
  ACTIVE: 'IN_PROGRESS',
  DONE: 'COMPLETED',
};

/** The Unit's called cross audits, newest first. Live: the Zones' states come from the audits. */
export function useCrossAuditRounds(unitId: string | undefined) {
  return useQuery({
    queryKey: ['cross-audits', unitId],
    queryFn: () => api.get<CrossAuditRound[]>(`/units/${unitId}/cross-audits`),
    enabled: unitId !== undefined,
    refetchInterval: 30_000,
  });
}

/** Completed by the Coordinator, or every Zone audited: nothing is left to wait for. */
export function roundClosed(round: CrossAuditRound): boolean {
  return round.completedAt !== null || round.zones.every((zone) => zone.state === 'COMPLETED');
}

/** An open round is on every board; a closed one only on Completed. */
export function roundsOnBoard(rounds: readonly CrossAuditRound[], board: RoundBoard): CrossAuditRound[] {
  return rounds.filter((round) => board === 'DONE' || !roundClosed(round));
}

/** "Due 18 Oct", or "Overdue since 18 Oct". */
export function roundDue(round: CrossAuditRound): string {
  const late = !roundClosed(round) && isOverdue(round);
  return `${late ? 'Overdue since' : 'Due'} ${formatDayMonth(`${round.dueOn}T12:00:00+05:30`)}`;
}

function count(round: CrossAuditRound, state: CrossAuditZoneState): number {
  return round.zones.filter((zone) => zone.state === state).length;
}

/** The card on an Audits board. Opens the round on that board's Zones. */
export function CrossAuditRoundCard({ round, board }: { round: CrossAuditRound; board: RoundBoard }) {
  const router = useRouter();
  const closed = roundClosed(round);
  const late = !closed && isOverdue(round);
  const zones = round.zones.length;
  const waiting = count(round, 'NOT_STARTED');
  const running = count(round, 'IN_PROGRESS');
  const done = count(round, 'COMPLETED');
  return (
    <Card
      rail={late ? 'crit' : closed ? 'none' : 'warn'}
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/cross-audit/[roundId]', params: { roundId: round.id, board } })}
    >
      <CardHeader
        title="Cross-zonal audit"
        description={`${zones} Zone${zones === 1 ? '' : 's'} · called ${formatDayMonth(round.createdAt)} by ${round.calledBy}`}
        action={
          round.completedAt ? <Chip>Completed</Chip> : late ? <Chip tone="crit">Overdue</Chip> : closed ? <Chip>All done</Chip> : undefined
        }
      />
      <Data>{`${waiting} not started · ${running} under way · ${done} done`}</Data>
      <Data>{roundDue(round)}</Data>
    </Card>
  );
}

/** The Android date dialog, from `from` (or a week out), never before today. */
export function pickDueDate(from: string | null, onPicked: (dueOn: string) => void) {
  DateTimePickerAndroid.open({
    value: from ? new Date(`${from}T12:00:00+05:30`) : new Date(Date.now() + 7 * 86_400_000),
    mode: 'date',
    minimumDate: new Date(),
    onChange: (event, date) => {
      const dueOn = event.type === 'set' && date ? istDateKey(date) : null;
      if (dueOn) onPicked(dueOn);
    },
  });
}

/**
 * Calling a cross audit: tick the Zones — or "Select all" — then the day it is due, then one
 * confirm naming both. Every Zone Leader of the Unit is notified once.
 */
export function CallCrossAuditSheet({ unitId, visible, onClose }: { unitId: string | undefined; visible: boolean; onClose: () => void }) {
  const styles = useStyles();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const queryClient = useQueryClient();
  const zones = useUnitZones(unitId);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (visible) setSelected([]);
  }, [visible]);

  const all = zones.length > 0 && selected.length === zones.length;
  const toggle = (zoneId: string, on: boolean) =>
    setSelected(zones.map((zone) => zone.id).filter((id) => (id === zoneId ? on : selected.includes(id))));
  const label = (zone: { code: string; name: string }) => zoneDisplayLabel(zone.code, zone.name);
  const what = selected.length === 1 ? label(zones.find((zone) => zone.id === selected[0])!) : `${selected.length} Zones`;

  const call = () =>
    pickDueDate(null, (dueOn) => {
      const day = formatDayMonth(`${dueOn}T12:00:00+05:30`);
      Alert.alert(`Call a cross audit of ${what}?`, `Every Zone Leader of the Unit is asked to audit ${what} by ${day}.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Notify Zone Leaders',
          onPress: () => {
            setBusy(true);
            api.post(`/units/${unitId}/cross-audit`, { zoneIds: selected, dueOn }).then(
              () => {
                setBusy(false);
                onClose();
                void queryClient.invalidateQueries({ queryKey: ['cross-audits', unitId] });
                Alert.alert('Zone Leaders notified', `The cross audit of ${what} is due by ${day}. It is on every board of the Audits tab.`);
              },
              (error: unknown) => {
                setBusy(false);
                Alert.alert('Could not call the cross audit', problemMessage(error) ?? 'Try again.');
              },
            );
          },
        },
      ]);
    });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: 14 + insets.bottom, maxHeight: height * 0.85 }]}>
        <View style={styles.head}>
          <Text style={styles.title} accessibilityRole="header">
            Cross audit of which Zones?
          </Text>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: all }}
            accessibilityLabel="Select all Zones"
            disabled={zones.length === 0}
            hitSlop={8}
            onPress={() => setSelected(all ? [] : zones.map((zone) => zone.id))}
            style={styles.selectAll}
          >
            <Text style={styles.selectAllText}>Select all</Text>
            <Icon name={all ? 'check-box' : 'check-box-outline-blank'} color={theme.color.ink} size={24} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {zones.length === 0 ? <Text style={styles.empty}>This Unit has no Zones yet.</Text> : null}
          {zones.map((zone) => (
            <CheckRow key={zone.id} label={label(zone)} checked={selected.includes(zone.id)} onChange={(on) => toggle(zone.id, on)} />
          ))}
        </ScrollView>
        <View style={styles.actions}>
          <View style={styles.action}>
            <Button icon="close" title="Cancel" variant="secondary" onPress={onClose} />
          </View>
          <View style={styles.action}>
            <Button
              icon="event"
              title={selected.length === 0 ? 'Pick Zones' : `Due date · ${selected.length}`}
              disabled={selected.length === 0}
              busy={busy}
              onPress={call}
            />
          </View>
        </View>
      </View>
    </Modal>
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
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.sm },
  title: {
    flexShrink: 1,
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.32,
  },
  selectAll: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48 },
  selectAllText: { fontFamily: theme.family.bold, fontSize: theme.font.sm, color: theme.color.ink },
  list: { gap: theme.space.sm },
  empty: { fontFamily: theme.family.regular, fontSize: theme.font.sm, color: theme.color.ink2 },
  actions: { flexDirection: 'row', gap: theme.space.sm },
  action: { flex: 1 },
}));
