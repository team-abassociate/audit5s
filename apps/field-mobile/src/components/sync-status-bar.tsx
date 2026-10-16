import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSegments } from 'expo-router';
import { readSyncStatus, type SyncDot } from '../lib/sync/status';
import { useLocalDatabase } from '../lib/db/provider';
import { KAIZEN_STRINGS } from '../lib/kaizen-strings';
import { useLanguage } from '../lib/language-provider';
import type { AppModule } from '../lib/secure-storage';
import { useSession } from '../lib/session';
import { retryDeadLetters } from '../lib/sync/engine';
import { useSync } from '../lib/sync/provider';
import { createThemedStyles, useTheme } from '../lib/theme';
import { useOpenModule } from './module-switch';
import { Avatar, Button } from './ui';

/**
 * The persistent bar of §9.9, on every field screen: who is signed in on the left (a tap
 * opens the profile), beside it the 5S | KAIZEN switch for a role holding Kaizen, and on the
 * right the sync status above a compact Sync now.
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
  const inKaizen = (useSegments() as string[])[0] === 'kaizen';
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const { user, can } = useSession();
  const showSwitch = can('kaizen', 'read');
  const { sync, online } = useSync();

  const status = useQuery({
    queryKey: ['local', 'sync-status'],
    queryFn: () => readSyncStatus(database),
    refetchInterval: 5_000,
  });

  const syncNow = useMutation({
    mutationFn: async () => {
      // STACK.md §5's "N failed — tap to retry". A dead letter waits for a person, and this
      // tap is that person: without it an item the server once refused — and everything
      // queued behind it — could never be sent again, even after the cause was fixed.
      if (status.data?.deadLettered) {
        await retryDeadLetters(database);
      }
      return sync();
    },
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
  const syncLabel = syncing ? 'Syncing…' : data.deadLettered > 0 ? 'Retry' : 'Sync now';

  return (
    <View style={[styles.bar, { paddingTop: insets.top + 2 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Your profile, ${user?.fullName ?? ''}`}
        hitSlop={6}
        onPress={() => router.push(inKaizen ? '/kaizen/profile' : '/profile')}
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Avatar name={user?.fullName} size={32} />
      </Pressable>

      {showSwitch ? <ModuleToggle current={inKaizen ? 'kaizen' : 'five-s'} /> : null}

      <View style={styles.side}>
        <View
          style={styles.status}
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={detail ? `${label}. ${detail}` : label}
        >
          <View style={[styles.dot, { backgroundColor: dotColour(data.dot, theme) }]} />
          <Text style={styles.label} numberOfLines={showSwitch ? 2 : 1}>
            {label}
          </Text>
        </View>
        <View style={styles.actionRow}>
          {detail ? (
            <Text style={styles.detail} numberOfLines={2} importantForAccessibility="no">
              {detail}
            </Text>
          ) : null}
          {/* Tappable offline too: "offline" is the last attempt's result, and a retry is how it ends.
              Beside the switch a 360dp phone has no room for the word: the symbol, still named. */}
          <Button icon="sync"
            compact
            title={showSwitch ? '' : syncLabel}
            accessibilityLabel={syncLabel}
            disabled={syncing}
            onPress={() => syncNow.mutate()}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * 5S | KAIZEN, one tap from every tab: the module open now is filled in ink, the other is the
 * one to tap. A 2px ink border and square ends, like the bar and the tab bar around it.
 */
function ModuleToggle({ current }: { current: AppModule }) {
  const styles = useStyles();
  const openModule = useOpenModule();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const halves = [
    { module: 'five-s', text: t.fiveSShort, name: t.fiveS },
    { module: 'kaizen', text: t.kaizen, name: t.kaizen },
  ] as const;
  return (
    <View style={styles.toggle}>
      {halves.map(({ module, text, name }) => {
        const selected = module === current;
        return (
          <Pressable
            key={module}
            testID={`module-bar-${module}`}
            accessibilityRole="button"
            accessibilityLabel={name}
            accessibilityState={{ selected }}
            // 32dp drawn, 44dp to the finger.
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={selected ? undefined : () => openModule(module)}
            style={[styles.half, selected && styles.halfSelected]}
          >
            <Text style={[styles.halfText, selected && styles.halfTextSelected]}>{text}</Text>
          </Pressable>
        );
      })}
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
  toggle: { flexDirection: 'row', borderWidth: 2, borderColor: theme.color.edge },
  half: { height: 32, paddingHorizontal: 10, justifyContent: 'center', backgroundColor: theme.color.tile },
  halfSelected: { backgroundColor: theme.color.ink },
  halfText: {
    fontFamily: theme.family.black,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: theme.color.ink3,
  },
  halfTextSelected: { color: theme.color.tile },
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
