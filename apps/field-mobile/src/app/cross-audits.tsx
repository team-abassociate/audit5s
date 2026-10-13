import { FlatList, Text } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Card, Data, EmptyState, Muted, Screen } from '../components/ui';
import { crossAuditCallZone, crossAuditStart, useOpenCrossAuditCalls } from '../components/cross-audit-calls';
import { formatDateTime } from '../lib/format';
import { createThemedStyles } from '../lib/theme';

/**
 * Every cross audit called and not yet answered on this phone (owner, 2026-10-13). One card
 * per call; tapping one starts its audit — the selfie, then that Zone. Each call needs its own
 * audit, so starting one leaves the others here.
 */
export default function CrossAuditsScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { calls, notifications } = useOpenCrossAuditCalls(true);
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Cross audits called' }} />
      <FlatList
        data={calls}
        keyExtractor={(call) => call.id}
        refreshing={notifications.isFetching}
        onRefresh={() => void notifications.refetch()}
        renderItem={({ item }) => {
          const zone = crossAuditCallZone(item);
          const unit = String(item.data.unitName ?? 'your Unit');
          const by = typeof item.data.calledBy === 'string' ? item.data.calledBy : null;
          return (
            <Card
              onPress={() => router.push(crossAuditStart(item))}
              accessibilityRole="button"
              accessibilityLabel={`Cross audit of ${zone} at ${unit}${by ? `, called by ${by}` : ''}, ${formatDateTime(item.createdAt)}. Starts the audit.`}
            >
              <Text style={styles.zone}>{zone}</Text>
              <Muted>{by ? `${unit} · called by ${by}` : unit}</Muted>
              <Data>{formatDateTime(item.createdAt)}</Data>
            </Card>
          );
        }}
        ListEmptyComponent={
          notifications.isLoading ? null : (
            <EmptyState title="No cross audit waiting" detail="When your Coordinator calls one, it appears here." />
          )
        }
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  zone: { fontFamily: theme.family.bold, fontSize: theme.font.base, color: theme.color.ink },
}));
