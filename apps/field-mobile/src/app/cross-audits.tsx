import { SectionList } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { groupAuditsByUnit } from '@audit5s/domain';
import { InUnit, UnitSectionHead, ZoneTags, unitSections } from '../components/audit-groups';
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
 *
 * Grouped by Unit like every audit list (owner, 2026-11-27), oldest due first, the Zone as a tag.
 */
export default function CrossAuditsScreen() {
  const router = useRouter();
  const { calls, standing } = useOpenCrossAuditCalls(true);
  const { user } = useSession();
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Cross audits called' }} />
      <SectionList
        sections={unitSections(groupAuditsByUnit(calls, (call) => call))}
        keyExtractor={(call) => call.id}
        renderSectionHeader={({ section }) => <UnitSectionHead section={section} showUnit noun={['call', 'calls']} />}
        stickySectionHeadersEnabled={false}
        refreshing={standing.isFetching}
        onRefresh={() => void standing.refetch()}
        renderItem={({ item }) => {
          const zone = crossAuditCallZone(item);
          const late = isOverdue(item);
          const due = crossAuditDue(item);
          const assignee = crossAuditAssignee(item, user?.id);
          return (
            <InUnit>
              <Card
                rail={late ? 'late' : 'none'}
                onPress={() => router.push(crossAuditStart(item))}
                accessibilityRole="button"
                accessibilityLabel={`Cross audit of ${zone} at ${item.unitName}, called by ${item.calledBy}. ${due}. Starts the audit.`}
              >
                <ZoneTags tags={[zone]} />
                <CardHeader
                  title="Cross audit"
                  description={[`Called by ${item.calledBy}`, assignee].filter(Boolean).join(' · ')}
                  action={late ? <Chip tone="late">Past due</Chip> : undefined}
                />
                <Data>{due}</Data>
              </Card>
            </InUnit>
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
