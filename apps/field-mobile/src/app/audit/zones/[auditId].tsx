import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { zoneDisplayLabel } from '@audit5s/domain';
import { Button, Card, EmptyState, Muted, Screen } from '../../../components/ui';
import {
  addLocalZone,
  completeLocalAudit,
  getLocalAudit,
  listLocalAuditZones,
  pauseLocalAudit,
  resumeCursor,
  resumeLocalAudit,
} from '../../../lib/db/audit.repository';
import { listLocalZones as listCatalogueZones } from '../../../lib/db/catalogue.repository';
import { useLocalDatabase } from '../../../lib/db/provider';
import { theme } from '../../../lib/theme';

/**
 * The Zones of one audit: what has been done, what is next, and the way back in.
 *
 * The resume banner of §9.8 is rendered from the local cursors — "Resumed — 23 of 50
 * answered in Zone 4" — so reopening an audit aborted three days ago costs no round trip.
 */
export default function AuditZonesScreen() {
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();

  const audit = useQuery({
    queryKey: ['local', 'audit', auditId],
    queryFn: async () => (await getLocalAudit(database, auditId))[0] ?? null,
  });

  const auditZones = useQuery({
    queryKey: ['local', 'audit-zones', auditId],
    queryFn: () => listLocalAuditZones(database, auditId),
  });

  const available = useQuery({
    enabled: Boolean(audit.data?.unitId),
    queryKey: ['local', 'zones', audit.data?.unitId],
    queryFn: () => listCatalogueZones(database, audit.data!.unitId),
  });

  const cursor = useQuery({
    queryKey: ['local', 'cursor', auditId],
    queryFn: () => resumeCursor(database, auditId),
  });

  const addZone = useMutation({
    mutationFn: async (zoneId: string) => {
      const sequenceNo = (auditZones.data?.length ?? 0) + 1;
      return addLocalZone(database, {
        auditId,
        zoneId,
        sequenceNo,
        checklistVersionId: audit.data?.checklistVersionId ?? null,
      });
    },
    onSuccess: async (auditZoneId) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      router.push({ pathname: '/audit/[auditZoneId]', params: { auditZoneId } });
    },
  });

  const resume = useMutation({
    mutationFn: async () => {
      await resumeLocalAudit(database, auditId);
      return resumeCursor(database, auditId);
    },
    onSuccess: async (target) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      if (target.auditZoneId) {
        router.push({
          pathname: '/audit/[auditZoneId]',
          params: { auditZoneId: target.auditZoneId },
        });
      }
    },
  });

  const abort = useMutation({
    mutationFn: () => pauseLocalAudit(database, auditId, 'Aborted by auditor'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local'] }),
  });

  const finish = useMutation({
    mutationFn: () => completeLocalAudit(database, auditId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local'] }),
  });

  if (audit.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.brand} />
      </Screen>
    );
  }

  const zonesInAudit = auditZones.data ?? [];
  const usedZoneIds = new Set(zonesInAudit.map((zone) => zone.zoneId));
  const remaining = (available.data ?? []).filter((zone) => !usedZoneIds.has(zone.id));
  const allComplete = zonesInAudit.length > 0 && zonesInAudit.every((z) => z.status === 'COMPLETED');
  const paused = audit.data?.status === 'PAUSED';

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Audit' }} />

      {paused && cursor.data?.auditZoneId ? (
        <Card style={styles.resumeBanner}>
          <Text style={styles.resumeText}>
            Paused — {cursor.data.answered} question{cursor.data.answered === 1 ? '' : 's'} answered
            in this Zone
          </Text>
          <Button title="Resume" busy={resume.isPending} onPress={() => resume.mutate()} />
        </Card>
      ) : null}

      <FlatList
        data={zonesInAudit}
        keyExtractor={(zone) => zone.id}
        ListEmptyComponent={
          <EmptyState title="No Zones yet" detail="Add the first Zone to begin the questionnaire." />
        }
        renderItem={({ item }) => (
          <Card>
            <Text style={styles.name}>
              {zoneDisplayLabel(item.zoneCodeSnapshot, item.zoneNameSnapshot)}
            </Text>
            <Muted>
              {item.status === 'COMPLETED' ? 'Finished' : item.status === 'DRAFT' ? 'Not started' : 'In progress'}
            </Muted>
            <View style={styles.action}>
              <Button
                title={item.status === 'COMPLETED' ? 'Review' : 'Open'}
                variant="secondary"
                onPress={() =>
                  router.push({
                    pathname: '/audit/[auditZoneId]',
                    params: { auditZoneId: item.id },
                  })
                }
              />
            </View>
          </Card>
        )}
        ListFooterComponent={
          <View style={styles.footer}>
            {remaining.length > 0 && !allComplete ? (
              <>
                <Text style={styles.sectionTitle}>Add next Zone</Text>
                {remaining.map((zone) => (
                  <Card key={zone.id}>
                    <Text style={styles.name}>{zoneDisplayLabel(zone.code, zone.name)}</Text>
                    {zone.description ? <Muted>{zone.description}</Muted> : null}
                    <View style={styles.action}>
                      <Button
                        title="Start this Zone"
                        busy={addZone.isPending}
                        onPress={() => addZone.mutate(zone.id)}
                      />
                    </View>
                  </Card>
                ))}
              </>
            ) : null}

            {allComplete && audit.data?.status !== 'COMPLETED' ? (
              <Button title="Finish audit" busy={finish.isPending} onPress={() => finish.mutate()} />
            ) : null}

            {audit.data?.status === 'IN_PROGRESS' ? (
              <Button
                title="Abort — save and pause"
                variant="secondary"
                onPress={() => abort.mutate()}
              />
            ) : null}

            <Muted>
              Saved on this device. Nothing here waits for a connection, and nothing is lost
              without one.
            </Muted>
          </View>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: theme.font.lg, fontWeight: '600', color: theme.color.text },
  action: { marginTop: theme.space.sm },
  footer: { gap: theme.space.sm, marginTop: theme.space.lg },
  sectionTitle: {
    fontSize: theme.font.sm,
    fontWeight: '700',
    color: theme.color.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  resumeBanner: { backgroundColor: '#FDF3DB', borderColor: '#BE7D0F' },
  resumeText: { fontSize: theme.font.base, color: theme.color.text, marginBottom: theme.space.sm },
});
