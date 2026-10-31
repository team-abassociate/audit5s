import { FlatList } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Card, CardHeader, Chip, Data, EmptyState, Screen } from '../components/ui';
import {
  crossAuditAssignee,
  crossAuditCallZone,
  crossAuditDue,
  crossAuditStart,
  useOpenCrossAuditCalls,
} from '../components/cross-audit-calls';
import { isOverdue } from '../lib/cross-audit-call';
import { useSession } from '../lib/session';

/**
 * Every cross audit called at the Unit and not yet done by anyone (owner, 2026-10-14), oldest
 * due first. One card per call; tapping one starts its audit — the selfie, then that Zone. Past
 * its date a call stays, marked overdue, until someone audits the Zone.
 */
export default function CrossAuditsScreen() {
  const router = useRouter();
  const { calls, standing } = useOpenCrossAuditCalls(true);
  const { user } = useSession();
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Cross audits called' }} />
      <FlatList
        data={calls}
        keyExtractor={(call) => call.id}
        refreshing={standing.isFetching}
        onRefresh={() => void standing.refetch()}
        renderItem={({ item }) => {
          const zone = crossAuditCallZone(item);
          const late = isOverdue(item);
          const due = crossAuditDue(item);
          const assignee = crossAuditAssignee(item, user?.id);
          return (
            <Card
              rail={late ? 'crit' : 'none'}
              onPress={() => router.push(crossAuditStart(item))}
              accessibilityRole="button"
              accessibilityLabel={`Cross audit of ${zone} at ${item.unitName}, called by ${item.calledBy}. ${due}. Starts the audit.`}
            >
              <CardHeader
                title={zone}
                description={[item.unitName, `called by ${item.calledBy}`, assignee].filter(Boolean).join(' · ')}
                action={late ? <Chip tone="crit">Overdue</Chip> : undefined}
              />
              <Data>{due}</Data>
            </Card>
          );
        }}
        ListEmptyComponent={
          standing.isLoading ? null : (
            <EmptyState title="No cross audit waiting" detail="When your Coordinator calls one, it appears here." />
          )
        }
      />
    </Screen>
  );
}
