import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Button, Card, EmptyState, Muted, Screen } from '../../components/ui';
import { listLocalAudits, pendingOutboxCount } from '../../lib/db/audit.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { theme } from '../../lib/theme';

/**
 * Audit history — **this device's** audits, read from SQLite.
 *
 * It lists what the device authored rather than what the server holds, which is the honest
 * thing on a phone that may not have synced for a week: an audit finished in a plant with
 * no signal is history the moment it is finished, not when the server hears about it.
 *
 * §9.9 requires the UI never to say "saved" when it means "queued". The footer says both,
 * separately.
 */
export default function HistoryScreen() {
  const database = useLocalDatabase();
  const router = useRouter();

  const audits = useQuery({
    queryKey: ['local', 'audits'],
    queryFn: () => listLocalAudits(database),
  });

  const pending = useQuery({
    queryKey: ['local', 'outbox-count'],
    queryFn: () => pendingOutboxCount(database),
  });

  return (
    <Screen>
      <FlatList
        data={audits.data ?? []}
        keyExtractor={(audit) => audit.id}
        ListEmptyComponent={
          <EmptyState
            title="No audits yet"
            detail="Open a Unit and start an audit. Everything you record is kept on this device."
          />
        }
        renderItem={({ item }) => (
          <Card>
            <Text style={styles.title}>{LABELS[item.auditType] ?? item.auditType}</Text>
            <Muted>
              {STATUS_LABELS[item.status] ?? item.status} ·{' '}
              {new Date(item.clientUpdatedAt).toLocaleString()}
            </Muted>
            <View style={styles.action}>
              <Button
                title={item.status === 'COMPLETED' ? 'Review' : 'Open'}
                variant="secondary"
                onPress={() =>
                  router.push({
                    pathname: '/audit/zones/[auditId]',
                    params: { auditId: item.id },
                  })
                }
              />
            </View>
          </Card>
        )}
        ListFooterComponent={
          <Muted>
            {pending.data === 0
              ? 'Everything on this device has been synced.'
              : `${pending.data ?? 0} item(s) saved on this device, waiting to sync.`}
          </Muted>
        }
      />
    </Screen>
  );
}

const LABELS: Record<string, string> = {
  EXTERNAL_5S: 'External 5S audit',
  CROSS_5S: 'Cross audit',
  WALK_BY: 'Walk-by',
};

const STATUS_LABELS: Record<string, string> = {
  ASSIGNED: 'Assigned',
  READY: 'Ready to start',
  IN_PROGRESS: 'In progress',
  PAUSED: 'Paused — resume any time',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const styles = StyleSheet.create({
  title: { fontSize: theme.font.lg, fontWeight: '600', color: theme.color.text },
  action: { marginTop: theme.space.sm },
});
