import { useCallback } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { awaitsResponse } from '@audit5s/domain';
import {
  Card,
  Chip,
  EmptyState,
  ErrorBanner,
  Muted,
  Screen,
  SectionHead,
  Slip,
  SlipText,
} from '../../components/ui';
import { syncCatalogue } from '../../lib/catalogue';
import { listLocalUnits } from '../../lib/db/catalogue.repository';
import { listLocalCorrectiveActions } from '../../lib/db/corrective-action.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { useSession } from '../../lib/session';
import { createThemedStyles, useTheme } from '../../lib/theme';

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
  const styles = useStyles();
  const theme = useTheme();
  const { scope } = useSession();
  // R-18: a Super Admin answers corrective actions too.
  const answersActions = scope?.role === 'ZONE_LEADER' || scope?.role === 'SUPER_ADMIN';
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

  // §2.4 step 5: a Zone Leader's nonconformities, from the device's own copy.
  const actions = useQuery({
    queryKey: ['local', 'corrective-actions'],
    queryFn: () => listLocalCorrectiveActions(database),
    enabled: answersActions,
  });
  const toDo = actions.data?.filter((action) => awaitsResponse(action.effectiveStatus)).length ?? 0;

  const renderUnit = useCallback(
    ({ item }: { item: { id: string; name: string } }) => (
      <Link href={{ pathname: '/unit/[unitId]', params: { unitId: item.id } }} asChild>
        <Card accessibilityRole="button" accessibilityHint="Opens this Unit's Zones">
          <Text style={styles.name}>{item.name}</Text>
          <Muted>Zones, checklists and the way into an audit</Muted>
        </Card>
      </Link>
    ),
    [styles],
  );

  if (units.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.ink} />
      </Screen>
    );
  }

  const count = units.data?.length ?? 0;

  return (
    <Screen>
      <FlatList
        testID="field-units-list"
        data={units.data ?? []}
        keyExtractor={(unit) => unit.id}
        renderItem={renderUnit}
        refreshControl={
          <RefreshControl
            refreshing={sync.isPending}
            onRefresh={() => sync.mutate()}
            colors={[theme.color.ink]}
            progressBackgroundColor={theme.color.tile}
          />
        }
        ListHeaderComponent={
          <>
            <ErrorBanner
              message={
                sync.error
                  ? 'Could not refresh. Showing what is stored on this device; pull down to try again.'
                  : null
              }
            />

            {/* The one slip on this screen, and only when something is waiting for a response. */}
            {answersActions && toDo > 0 ? (
              <Link href="/actions" asChild>
                <Slip
                  accessibilityRole="button"
                  title={`${toDo} nonconformit${toDo === 1 ? 'y' : 'ies'} waiting for you`}
                >
                  <SlipText>
                    Record each fix with a live photograph, or explain why it is not possible.
                  </SlipText>
                </Slip>
              </Link>
            ) : null}
            {answersActions && toDo === 0 ? (
              <Link href="/actions" asChild>
                <Card accessibilityRole="button">
                  <View style={styles.row}>
                    <Text style={styles.name}>Nonconformities</Text>
                    <Chip>Nothing waiting</Chip>
                  </View>
                </Card>
              </Link>
            ) : null}

            {count > 0 ? (
              <SectionHead
                title={`${count} Unit${count === 1 ? '' : 's'}`}
                description="Stored on this device. Pull down to refresh."
              />
            ) : null}
          </>
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
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.sm },
  name: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
}));
