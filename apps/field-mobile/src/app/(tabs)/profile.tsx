import { Alert, ScrollView, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { Button, Card, Heading, Muted, Screen } from '../../components/ui';
import { lastCatalogueSyncAt, syncCatalogue } from '../../lib/catalogue';
import { useLocalDatabase } from '../../lib/db/provider';
import { useSession } from '../../lib/session';
import { useSync } from '../../lib/sync/provider';
import { checkLogoutGate } from '../../lib/sync/status';
import { createThemedStyles } from '../../lib/theme';
import type { ConsultantActivity } from '@audit5s/contracts';
import { api } from '../../lib/api';

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  CONSULTANT: 'Consultant',
  COORDINATOR: 'Coordinator',
  ZONE_LEADER: 'Zone Leader',
};

export default function ProfileScreen() {
  const styles = useStyles();
  const { user, scope, signOut } = useSession();
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
        <Card>
          <Heading>{user.fullName}</Heading>
          <Muted>{ROLE_LABELS[user.role] ?? user.role}</Muted>
        </Card>

        <Card>
          <Row label="Login ID" value={user.loginId} />
          <Row label="Phone" value={user.phoneE164} />
          <Row label="Email" value={user.email ?? '—'} />
          <Row
            label="Units"
            value={
              scope?.organizationWide
                ? 'All Units'
                : String(scope?.unitIds.length ?? 0)
            }
          />
          <Row
            label="Last sign-in"
            value={user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—'}
          />
        </Card>

        <Card>
          <Row
            label="Catalogue"
            value={
              lastSync.data ? new Date(lastSync.data).toLocaleString() : 'Never synced'
            }
          />
          <Muted>
            Units, Zones and checklists are stored on this device and read without a
            network.
          </Muted>
          <View style={styles.syncButton}>
            <Button
              title="Sync now"
              variant="secondary"
              busy={sync.isPending}
              onPress={() => sync.mutate()}
            />
          </View>
          {sync.error ? (
            <Muted>Could not reach the server. The stored catalogue is unchanged.</Muted>
          ) : null}
        </Card>

        {user.role === 'CONSULTANT' ? (
          <Card>
            <Heading>My activity</Heading>
            {activity.data ? (
              <>
                <Row label="Audits completed" value={String(activity.data.auditsCompleted)} />
                <Row label="Zones covered" value={String(activity.data.zonesCovered)} />
                <Row label="Photos captured" value={String(activity.data.photosCaptured)} />
                <Row
                  label="Average duration"
                  value={
                    activity.data.averageDurationMinutes === null
                      ? '—'
                      : `${activity.data.averageDurationMinutes.toFixed(0)} min`
                  }
                />
                <Row
                  label="Last active"
                  value={
                    activity.data.lastActiveAt
                      ? new Date(activity.data.lastActiveAt).toLocaleString()
                      : '—'
                  }
                />
              </>
            ) : (
              <Muted>{activity.isError ? 'Activity is unavailable offline.' : 'No completed audits yet.'}</Muted>
            )}
          </Card>
        ) : null}

        <Link href="/notifications" asChild>
          <Card>
            <Row label="Notifications" value="Open" />
          </Card>
        </Link>

        <Card>
          <Muted>
            App version {Constants.expoConfig?.version ?? 'dev'}
          </Muted>
        </Card>

        <Button
          title="Sign out"
          variant="secondary"
          onPress={() => void attemptSignOut()}
        />
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { gap: theme.space.sm, paddingBottom: theme.space.xl },
  syncButton: { marginTop: theme.space.sm },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.space.sm,
    gap: theme.space.md,
  },
  rowLabel: { fontFamily: theme.family.medium, fontSize: theme.font.label, color: theme.color.ink3, textTransform: 'uppercase', letterSpacing: 1.1 },
  rowValue: { fontFamily: theme.family.mono, fontSize: theme.font.sm, color: theme.color.ink, flexShrink: 1, textAlign: 'right' },
}));
