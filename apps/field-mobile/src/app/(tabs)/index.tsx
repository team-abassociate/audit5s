import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { Card, EmptyState, ErrorBanner, Muted, Screen } from '../../components/ui';
import { syncCatalogue } from '../../lib/catalogue';
import { listLocalUnits } from '../../lib/db/catalogue.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';

/**
 * The Units the signed-in user may touch — **rendered from SQLite** (§2.3 step 3).
 *
 * The list works with the radio off. Pull-to-refresh runs a catalogue sync, and a sync
 * that fails leaves the cached list exactly as it was: losing the network must not empty
 * the screen an auditor is standing in front of.
 *
 * Nothing is filtered here. `GET /sync/catalogue` returns exactly what the actor's scope
 * resolver allows, so a revoked assignment disappears on the next sync rather than being
 * hidden by the client.
 */
export default function UnitsScreen() {
  const { scope } = useSession();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();

  const units = useQuery({
    queryKey: ['local', 'units'],
    queryFn: () => listLocalUnits(database),
  });

  const sync = useMutation({
    mutationFn: () => syncCatalogue(database),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });

  // One catalogue pull on open. It is fire-and-forget: the screen has already rendered
  // from the cache by the time it resolves, and a failure changes nothing on screen.
  useQuery({
    queryKey: ['catalogue', 'bootstrap'],
    queryFn: async () => {
      await sync.mutateAsync().catch(() => undefined);
      return true;
    },
    staleTime: 60_000,
  });

  if (units.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.brand} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ErrorBanner
        message={
          sync.error ? 'Could not refresh — showing what is stored on this device.' : null
        }
      />

      <FlatList
        data={units.data ?? []}
        keyExtractor={(unit) => unit.id}
        refreshControl={
          <RefreshControl refreshing={sync.isPending} onRefresh={() => sync.mutate()} />
        }
        ListEmptyComponent={
          <EmptyState
            title="No Units assigned"
            detail={
              scope?.role === 'CONSULTANT'
                ? 'An administrator has not assigned you to a Unit yet. Pull down to check again.'
                : 'Your account is not linked to a Unit.'
            }
          />
        }
        renderItem={({ item }) => (
          <Link href={{ pathname: '/unit/[unitId]', params: { unitId: item.id } }} asChild>
            <Card>
              <Text style={styles.code}>{item.code}</Text>
              <Text style={styles.name}>{item.name}</Text>
              <Muted>Tap to see this Unit’s Zones</Muted>
            </Card>
          </Link>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: 'center', justifyContent: 'center' },
  code: {
    fontSize: theme.font.sm,
    fontWeight: '700',
    color: theme.color.accent,
    letterSpacing: 0.5,
  },
  name: {
    fontSize: theme.font.lg,
    fontWeight: '600',
    color: theme.color.text,
    marginTop: theme.space.xs,
  },
});
