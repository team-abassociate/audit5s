import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readSyncStatus, type SyncDot } from '../lib/sync/status';
import { useLocalDatabase } from '../lib/db/provider';
import { useSync } from '../lib/sync/provider';
import { theme } from '../lib/theme';

/**
 * The persistent status affordance of §9.9, on every field screen.
 *
 * §9.9 ends with the rule this component exists to keep:
 *
 * > The UI must never say "saved" when it means "queued". It says **"Saved on this device"**
 * > and separately **"Synced"** — an honest distinction that prevents the most damaging
 * > field misunderstanding.
 *
 * So there is no state here that reads as "done" while anything is pending, and the count
 * is split into items and photographs because a Zone that owes eleven answers and a Zone
 * that owes eleven photographs are different problems on a weak connection.
 */
const DOT_COLOUR: Record<SyncDot, string> = {
  synced: '#1B7F4B',
  pending: '#BE7D0F',
  syncing: '#2A7097',
  failed: '#B3261E',
};

export function SyncStatusBar() {
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const { sync, online } = useSync();

  const status = useQuery({
    queryKey: ['local', 'sync-status'],
    queryFn: () => readSyncStatus(database),
    refetchInterval: 5_000,
  });

  const syncNow = useMutation({
    mutationFn: () => sync(),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });

  const data = status.data;
  if (!data) return null;

  return (
    <View style={styles.bar}>
      <View style={[styles.dot, { backgroundColor: DOT_COLOUR[data.dot] }]} />

      <View style={styles.text}>
        <Text style={styles.label}>{describe(data)}</Text>
        {!online && (
          // §9.9's offline banner, in the words it prescribes: the work is not at risk.
          <Text style={styles.detail}>Offline — your work is saved on this device</Text>
        )}
        {online && data.lastSuccessfulPushAt && (
          <Text style={styles.detail}>Last synced {relative(data.lastSuccessfulPushAt)}</Text>
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => syncNow.mutate()}
        disabled={syncNow.isPending || data.syncing || !online}
        style={[styles.action, (syncNow.isPending || !online) && styles.actionDisabled]}
      >
        <Text style={styles.actionLabel}>{syncNow.isPending ? 'Syncing…' : 'Sync now'}</Text>
      </Pressable>
    </View>
  );
}

function describe(status: {
  dot: SyncDot;
  pendingItems: number;
  pendingPhotos: number;
  deadLettered: number;
}): string {
  if (status.deadLettered > 0) {
    return `${status.deadLettered} item${status.deadLettered === 1 ? '' : 's'} need attention`;
  }
  if (status.dot === 'syncing') return 'Syncing…';
  if (status.pendingItems === 0) return 'All synced';

  const items = `${status.pendingItems} item${status.pendingItems === 1 ? '' : 's'}`;
  const photos =
    status.pendingPhotos > 0
      ? ` · ${status.pendingPhotos} photo${status.pendingPhotos === 1 ? '' : 's'}`
      : '';
  // "Saved on this device", never "saved" — the distinction §9.9 insists on.
  return `Saved on this device: ${items}${photos}`;
}

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#FFF7F3',
    borderBottomWidth: 1,
    borderBottomColor: '#E8D7D1',
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  text: { flex: 1 },
  label: { fontSize: 13, fontWeight: '600', color: theme.color.text },
  detail: { fontSize: 11, color: theme.color.textMuted, marginTop: 1 },
  action: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: theme.color.brand,
  },
  actionDisabled: { opacity: 0.45 },
  actionLabel: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
