import { Alert, ScrollView, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'expo-router';
import type { ConsultantActivity } from '@audit5s/contracts';
import {
  Avatar,
  Button,
  Card,
  CardHeader,
  Chip,
  ChoiceList,
  Data,
  ErrorBanner,
  LedgerRow,
  Muted,
  Screen,
  StatGrid,
} from '../../components/ui';
import { api } from '../../lib/api';
import { lastCatalogueSyncAt, syncCatalogue } from '../../lib/catalogue';
import { useLocalDatabase } from '../../lib/db/provider';
import { formatDateTime } from '../../lib/format';
import { ROLE_LABELS } from '../../lib/labels';
import { useSession } from '../../lib/session';
import { useSync } from '../../lib/sync/provider';
import { checkLogoutGate } from '../../lib/sync/status';
import {
  createThemedStyles,
  THEME_LABELS,
  THEME_PREFERENCES,
  useThemeChoice,
  type ThemePreference,
} from '../../lib/theme';

export default function ProfileScreen() {
  const styles = useStyles();
  const { user, scope, signOut } = useSession();
  const theme = useThemeChoice();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  // Named `pushWork` rather than `sync`: this screen already has a `sync` mutation for the
  // *catalogue* pull, and the two are opposite directions.
  const { sync: pushWork } = useSync();

  /**
   * §9.7's logout gate.
   *
   * > 0 unsynced → clear tokens, wipe local audit data, log out.
   * > \>0 → BLOCK with "You have 14 unsynced items (3 photos)…" — Sync now / Keep & log out.
   *
   * "Keep & log out" is offered and it **keeps** the data: §9.7 is explicit that a
   * force-logout never wipes unsynced work, and the retained database stays tagged to this
   * user so a different one neither reads it nor clears it. There is no branch here that
   * deletes anything.
   */
  const attemptSignOut = async () => {
    const gate = await checkLogoutGate(database);
    if (!gate.blocked) {
      await signOut();
      return;
    }

    Alert.alert('You have work that has not synced', gate.message ?? '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sync now',
        onPress: () => {
          void (async () => {
            const result = await pushWork();
            const after = await checkLogoutGate(database);
            if (!after.blocked) {
              await signOut();
            } else {
              Alert.alert(
                'Still not synced',
                result.error
                  ? `${result.error}. Your work is safe on this device.`
                  : 'Some items are still waiting. Your work is safe on this device.',
              );
            }
          })();
        },
      },
      {
        text: 'Keep & log out',
        // The database is retained, tagged to this user. Nothing is deleted.
        onPress: () => void signOut(),
      },
    ]);
  };

  const lastSync = useQuery({
    queryKey: ['local', 'last-catalogue-sync'],
    queryFn: () => lastCatalogueSyncAt(database),
  });

  const sync = useMutation({
    mutationFn: () => syncCatalogue(database),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local'] }),
  });

  const activity = useQuery({
    queryKey: ['analytics', 'activity', 'me'],
    queryFn: () => api.get<ConsultantActivity | null>('/analytics/activity/me'),
    enabled: user?.role === 'CONSULTANT',
    staleTime: 5 * 60_000,
  });

  if (!user) {
    return (
      <Screen>
        <Muted>Not signed in.</Muted>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        {/* The web topbar's identity chip: initials on ink, name, login ID. */}
        <Card>
          <View style={styles.who}>
            <Avatar name={user.fullName} />
            <View style={styles.whoText}>
              <Text style={styles.name}>{user.fullName}</Text>
              <Data>{user.loginId}</Data>
              <View style={styles.role}>
                <Chip>{ROLE_LABELS[user.role]}</Chip>
              </View>
            </View>
          </View>
        </Card>

        <Card>
          <CardHeader title="Account" />
          <View style={styles.rows} />
          <LedgerRow label="Phone" value={user.phoneE164} />
          <LedgerRow label="Email" value={user.email ?? '—'} />
          <LedgerRow
            label="Units"
            value={scope?.organizationWide ? 'All Units' : String(scope?.unitIds.length ?? 0)}
          />
          <LedgerRow
            label="Last sign-in"
            value={user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}
            last
          />
        </Card>

        {/*
          The theme, on the screen the initials in the top-left corner open. Light is the
          app's default whatever the phone is set to; this is where that is overridden, and
          the choice outlives a sign-out because it belongs to the handset.
        */}
        <Card>
          <CardHeader
            title="Appearance"
            description="Light is the default. Dark is for a dim store room; System follows the phone."
          />
          <ChoiceList<ThemePreference>
            options={THEME_PREFERENCES.map((preference) => ({
              value: preference,
              label: THEME_LABELS[preference],
              detail:
                preference === 'system'
                  ? `Currently ${theme.scheme === 'dark' ? 'dark' : 'light'}`
                  : null,
            }))}
            value={theme.preference}
            onChange={theme.choose}
          />
        </Card>

        <Card>
          <CardHeader
            title="Catalogue"
            description="Units, Zones and checklists are stored on this device and read without a network."
          />
          <View style={styles.rows} />
          <LedgerRow
            label="Last synced"
            value={lastSync.data ? formatDateTime(lastSync.data) : 'Never'}
            last
          />
          <View style={styles.cardAction}>
            <ErrorBanner
              message={sync.error ? 'Could not reach the server. The stored catalogue is unchanged.' : null}
            />
            <Button
              title="Sync catalogue"
              variant="secondary"
              busy={sync.isPending}
              onPress={() => sync.mutate()}
            />
          </View>
        </Card>

        {user.role === 'CONSULTANT' ? (
          <Card>
            <CardHeader
              title="My activity"
              description="Completed audits, Zones covered and photographs captured."
            />
            {activity.data ? (
              <>
                <StatGrid
                  items={[
                    { label: 'Audits', value: String(activity.data.auditsCompleted) },
                    { label: 'Zones', value: String(activity.data.zonesCovered) },
                    { label: 'Photos', value: String(activity.data.photosCaptured) },
                  ]}
                />
                <View style={styles.cardAction}>
                  <LedgerRow
                    label="Average duration"
                    value={
                      activity.data.averageDurationMinutes === null
                        ? '—'
                        : `${activity.data.averageDurationMinutes.toFixed(0)} min`
                    }
                  />
                  <LedgerRow
                    label="Last active"
                    value={activity.data.lastActiveAt ? formatDateTime(activity.data.lastActiveAt) : '—'}
                    last
                  />
                </View>
              </>
            ) : (
              <Muted>{activity.isError ? 'Activity is unavailable offline.' : 'No completed audits yet.'}</Muted>
            )}
          </Card>
        ) : null}

        <Link href="/notifications" asChild>
          <Card accessibilityRole="button">
            <View style={styles.linkRow}>
              <Text style={styles.name}>Notifications</Text>
              <Muted>Open</Muted>
            </View>
          </Card>
        </Link>

        <Button title="Sign out" variant="secondary" onPress={() => void attemptSignOut()} />
        <Text style={styles.version}>App version {Constants.expoConfig?.version ?? 'dev'}</Text>
      </ScrollView>
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.xl },
  who: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  role: { marginTop: 6 },
  rows: { marginTop: -10 },
  whoText: { flex: 1, gap: 2 },
  name: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
  },
  cardAction: { marginTop: theme.space.md },
  linkRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  version: {
    fontFamily: theme.family.mono,
    fontSize: 11.5,
    color: theme.color.ink3,
    textAlign: 'center',
    marginTop: theme.space.lg,
  },
}));
