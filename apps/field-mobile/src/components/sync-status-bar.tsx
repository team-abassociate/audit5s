import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readSyncStatus, type SyncDot } from '../lib/sync/status';
import { useLocalDatabase } from '../lib/db/provider';
import { useSync } from '../lib/sync/provider';
import { createThemedStyles, useTheme } from '../lib/theme';

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
export function SyncStatusBar() {
  const styles = useStyles();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
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
  // Keep the status-bar inset until the first read: the navigator below has had its top inset zeroed.
  if (!data) return <View style={{ paddingTop: insets.top, backgroundColor: theme.color.tile2 }} />;

  return (
    <View style={[styles.bar, { paddingTop: insets.top + theme.space.sm }]}>
      <View style={[styles.dot, { backgroundColor: dotColour(data.dot, theme) }]} />

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

function dotColour(dot: SyncDot, theme: ReturnType<typeof useTheme>): string {
  if (dot === 'synced') return theme.color.okBand;
  if (dot === 'pending') return theme.color.warnBand;
  if (dot === 'failed') return theme.color.critBand;
  return theme.color.accent;
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

const useStyles = createThemedStyles((theme) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: theme.color.tile2,
    borderBottomWidth: 2,
    borderBottomColor: theme.color.edge,
  },
  dot: { width: 10, height: 10 },
  text: { flex: 1 },
  label: { fontFamily: theme.family.medium, fontSize: theme.font.sm, color: theme.color.ink },
  detail: { fontFamily: theme.family.regular, fontSize: theme.font.label, color: theme.color.ink2, marginTop: 1 },
  action: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.ink,
  },
  actionDisabled: { opacity: 0.45 },
  actionLabel: { color: theme.color.board, fontFamily: theme.family.medium, fontSize: 12 },
}));
