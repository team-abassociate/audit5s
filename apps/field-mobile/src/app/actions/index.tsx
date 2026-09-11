import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Link, Stack } from 'expo-router';
import { awaitsResponse, isOverdue } from '@audit5s/domain';
import { Card, EmptyState, Muted, Screen } from '../../components/ui';
import {
  listLocalCorrectiveActions,
  statusLabel,
  type LocalAction,
} from '../../lib/db/corrective-action.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { theme } from '../../lib/theme';

/**
 * §2.4 step 5, "Opens Nonconformities": every open item of the Zone Leader's Unit — from
 * external audits and cross audits alike — **rendered from SQLite**, so the list is there
 * with the radio off. Items the device has answered but not yet synced say so.
 */
export default function NonconformitiesScreen() {
  const database = useLocalDatabase();
  const actions = useQuery({
    queryKey: ['local', 'corrective-actions'],
    queryFn: () => listLocalCorrectiveActions(database),
  });

  const rows = [...(actions.data ?? [])].sort(
    (a, b) => Number(awaitsResponse(b.effectiveStatus)) - Number(awaitsResponse(a.effectiveStatus)),
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Nonconformities' }} />
      <FlatList
        data={rows}
        keyExtractor={(action) => action.id}
        ListEmptyComponent={
          <EmptyState title="Nothing open" detail="Pull the catalogue on the Units tab to check again." />
        }
        renderItem={({ item }) => (
          <Link href={{ pathname: '/actions/[actionId]', params: { actionId: item.id } }} asChild>
            <Card>
              <View style={styles.row}>
                <Text style={styles.zone}>
                  Zone {item.zoneCode} — {item.zoneName}
                </Text>
                <Text style={[styles.status, { color: statusColor(item) }]}>{statusLabel(item)}</Text>
              </View>
              <Muted>
                {item.questionGlobalOrder ? `Q${item.questionGlobalOrder}: ${item.questionText ?? ''}` : 'Walk-by observation'}
              </Muted>
              {item.dueAt && (
                <Muted>
                  Due {new Date(item.dueAt).toLocaleDateString()}
                  {isOverdue(item.effectiveStatus, item.dueAt, Date.now()) ? ' — overdue' : ''}
                </Muted>
              )}
            </Card>
          </Link>
        )}
      />
    </Screen>
  );
}

function statusColor(action: LocalAction): string {
  if (action.pendingSubmissionId) return theme.color.textMuted;
  return awaitsResponse(action.effectiveStatus) ? theme.color.accent : theme.color.textMuted;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.sm },
  zone: { fontSize: theme.font.base, fontWeight: '600', color: theme.color.text, flexShrink: 1 },
  status: { fontSize: theme.font.sm, fontWeight: '600' },
});
