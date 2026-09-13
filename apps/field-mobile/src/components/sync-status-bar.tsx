import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { readSyncStatus, type SyncDot } from '../lib/sync/status';
import { useLocalDatabase } from '../lib/db/provider';
import { useSession } from '../lib/session';
import { useSync } from '../lib/sync/provider';
import { createThemedStyles, useTheme } from '../lib/theme';
import { Avatar, Button } from './ui';

/**
 * The persistent bar of §9.9, on every field screen: who is signed in on the left (a tap
 * opens the profile), and on the right the sync status above a compact Sync now.
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
  const router = useRouter();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const { user } = useSession();
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

  const label = describe(data);
  // §9.9's offline banner, in the words it prescribes: the work is not at risk.
  const detail = !online
    ? 'Offline — your work is saved on this device'
    : data.lastSuccessfulPushAt
      ? `Last synced ${relative(data.lastSuccessfulPushAt)}`
      : null;
  const syncing = syncNow.isPending || data.syncing;

  return (
    <View style={[styles.bar, { paddingTop: insets.top + 2 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Your profile, ${user?.fullName ?? ''}`}
        hitSlop={6}
        onPress={() => router.push('/profile')}
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Avatar name={user?.fullName} size={32} />
      </Pressable>

      <View style={styles.side}>
        <View
          style={styles.status}
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={detail ? `${label}. ${detail}` : label}
        >
          <View style={[styles.dot, { backgroundColor: dotColour(data.dot, theme) }]} />
          <Text style={styles.label} numberOfLines={1}>
            {label}
          </Text>
        </View>
        <View style={styles.actionRow}>
          {detail ? (
            <Text style={styles.detail} numberOfLines={2} importantForAccessibility="no">
              {detail}
            </Text>
          ) : null}
          {/* Tappable offline too: "offline" is the last attempt's result, and a retry is how it ends. */}
          <Button
            compact
            title={syncing ? 'Syncing…' : 'Sync now'}
            disabled={syncing}
            onPress={() => syncNow.mutate()}
          />
        </View>
      </View>
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
    gap: 12,
    paddingHorizontal: theme.space.md,
    paddingBottom: 6,
    backgroundColor: theme.color.tile2,
    borderBottomWidth: 2,
    borderBottomColor: theme.color.edge,
  },
  pressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
  side: { flex: 1, alignItems: 'flex-end', gap: 2 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '100%' },
  dot: { width: 9, height: 9 },
  label: { flexShrink: 1, fontFamily: theme.family.medium, fontSize: 12.5, lineHeight: 16, color: theme.color.ink },
  actionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10 },
  detail: {
    flexShrink: 1,
    fontFamily: theme.family.regular,
    fontSize: 11,
    lineHeight: 13,
    color: theme.color.ink2,
    textAlign: 'right',
  },
}));
