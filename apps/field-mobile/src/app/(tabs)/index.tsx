import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { Page, Unit } from '@audit5s/contracts';
import { Card, EmptyState, ErrorBanner, Muted, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import type { ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';

/**
 * The Units the signed-in user may actually touch.
 *
 * This list is not filtered on the device. `GET /units` returns exactly what the actor's
 * scope resolver allows — `assigned_units` for a Consultant, `own_unit` for a Zone Leader
 * — so a device cannot widen it by editing a request, and a revoked assignment disappears
 * on the next fetch rather than at token expiry.
 */
export default function UnitsScreen() {
  const { scope } = useSession();

  const query = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units'),
  });

  if (query.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.brand} />
      </Screen>
    );
  }

  const units = query.data?.data ?? [];

  return (
    <Screen>
      <ErrorBanner
        message={query.error ? (query.error as ApiError).message ?? 'Could not load Units' : null}
      />

      <FlatList
        data={units}
        keyExtractor={(unit) => unit.id}
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
        }
        ListEmptyComponent={
          <EmptyState
            title="No Units assigned"
            detail={
              scope?.role === 'CONSULTANT'
                ? 'An administrator has not assigned you to a Unit yet.'
                : 'Your account is not linked to a Unit.'
            }
          />
        }
        renderItem={({ item }) => (
          <Card>
            <View style={styles.row}>
              <Text style={styles.code}>{item.code}</Text>
              {item.archivedAt ? <Text style={styles.archived}>Archived</Text> : null}
            </View>
            <Text style={styles.name}>{item.name}</Text>
            <Muted>{[item.city, item.state].filter(Boolean).join(', ') || 'No address on file'}</Muted>
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  code: { fontSize: theme.font.sm, fontWeight: '700', color: theme.color.accent, letterSpacing: 0.5 },
  archived: { fontSize: theme.font.sm, color: theme.color.textMuted },
  name: { fontSize: theme.font.lg, fontWeight: '600', color: theme.color.text, marginTop: theme.space.xs },
});
