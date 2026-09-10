import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { zoneDisplayLabel } from '@audit5s/domain';
import { Button, Card, EmptyState, Muted, Screen } from '../../components/ui';
import { createLocalAudit } from '../../lib/db/audit.repository';
import {
  getLocalUnit,
  listLocalChecklistVersions,
  listLocalZones,
} from '../../lib/db/catalogue.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';

/**
 * A Unit's active Zones, read from SQLite, and the way into an audit.
 *
 * Starting one writes a row locally and nothing else: no request is made, and none is
 * waited for. The server hears about the audit when the outbox drains, and arbitrates
 * device ownership then (D7) — until it does, the questionnaire is fully usable, which is
 * the whole of §9.1.
 */
export default function UnitZonesScreen() {
  const { unitId } = useLocalSearchParams<{ unitId: string }>();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { scope } = useSession();

  const unit = useQuery({
    queryKey: ['local', 'unit', unitId],
    queryFn: () => getLocalUnit(database, unitId),
  });

  const zones = useQuery({
    queryKey: ['local', 'zones', unitId],
    queryFn: () => listLocalZones(database, unitId),
  });

  const versions = useQuery({
    queryKey: ['local', 'checklist-versions'],
    queryFn: () => listLocalChecklistVersions(database),
  });

  const title = unit.data?.[0]?.name ?? 'Zones';

  // A Zone Leader runs cross audits (N4, D9); a Consultant runs external ones against an
  // assignment. The device picks the type from the role rather than asking, because those
  // are the only two an auditor on this screen could be starting.
  const auditType = scope?.role === 'ZONE_LEADER' ? 'CROSS_5S' : 'EXTERNAL_5S';

  const startAudit = useMutation({
    mutationFn: () =>
      createLocalAudit(database, {
        unitId,
        auditType,
        // The first published version on the device. Phase 4 lets the auditor pick the
        // department when a Unit uses more than one.
        checklistVersionId: versions.data?.[0]?.id ?? null,
      }),
    onSuccess: async (auditId) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      router.push({ pathname: '/audit/zones/[auditId]', params: { auditId } });
    },
  });

  return (
    <Screen>
      <Stack.Screen options={{ title, headerBackTitle: 'Units' }} />

      <FlatList
        data={zones.data ?? []}
        keyExtractor={(zone) => zone.id}
        ListEmptyComponent={
          <EmptyState
            title="No Zones"
            detail="This Unit has no active Zones yet. The Coordinator creates them in the admin app."
          />
        }
        ListHeaderComponent={
          (zones.data ?? []).length > 0 ? (
            <View style={styles.start}>
              <Button
                title="Start an audit here"
                busy={startAudit.isPending}
                onPress={() => startAudit.mutate()}
              />
              <Muted>Works with the radio off. Everything is saved on this device.</Muted>
            </View>
          ) : null
        }
        ListFooterComponent={
          (versions.data ?? []).length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Checklists on this device</Text>
              {(versions.data ?? []).map((version) => (
                <Link
                  key={version.id}
                  href={{ pathname: '/checklist/[versionId]', params: { versionId: version.id } }}
                  asChild
                >
                  <Card>
                    <Text style={styles.name}>{version.templateName}</Text>
                    <Muted>
                      v{version.versionNumber} · {version.totalQuestions} questions
                    </Muted>
                  </Card>
                </Link>
              ))}
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Card>
            <Text style={styles.name}>{zoneDisplayLabel(item.code, item.name)}</Text>
            {item.description ? <Muted>{item.description}</Muted> : null}
            <Muted>
              {item.zoneLeaderName ? `Zone Leader: ${item.zoneLeaderName}` : 'No Zone Leader'}
            </Muted>
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  start: { gap: theme.space.sm, marginBottom: theme.space.md },
  name: { fontSize: theme.font.lg, fontWeight: '600', color: theme.color.text },
  section: { marginTop: theme.space.lg },
  sectionTitle: {
    fontSize: theme.font.sm,
    fontWeight: '700',
    color: theme.color.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: theme.space.sm,
  },
});
