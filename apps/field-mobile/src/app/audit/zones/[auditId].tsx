import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
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
import { createThemedStyles, useTheme } from '../../../lib/theme';

/**
 * The Zones of one audit: what has been done, what is next, and the way back in.
 *
 * The resume banner of §9.8 is rendered from the local cursors — "Resumed — 23 of 50
 * answered in Zone 4" — so reopening an audit aborted three days ago costs no round trip.
 */
export default function AuditZonesScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [walkBySetup, setWalkBySetup] = useState<{
    zoneId: string;
    description: string;
    leaderId: string | null;
  } | null>(null);

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
    mutationFn: async (input: {
      zoneId: string;
      zoneDescription?: string | null;
      zoneLeaderUserId?: string;
    }) => {
      const sequenceNo = (auditZones.data?.length ?? 0) + 1;
      return addLocalZone(database, {
        auditId,
        zoneId: input.zoneId,
        sequenceNo,
        checklistVersionId: audit.data?.checklistVersionId ?? null,
        ...(input.zoneDescription !== undefined
          ? { zoneDescription: input.zoneDescription }
          : {}),
        ...(input.zoneLeaderUserId ? { zoneLeaderUserId: input.zoneLeaderUserId } : {}),
      });
    },
    onSuccess: async (auditZoneId) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      setWalkBySetup(null);
      router.push({
        pathname:
          audit.data?.auditType === 'WALK_BY'
            ? '/walk-by/[auditZoneId]'
            : '/audit/[auditZoneId]',
        params: { auditZoneId },
      });
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
          pathname:
            audit.data?.auditType === 'WALK_BY'
              ? '/walk-by/[auditZoneId]'
              : '/audit/[auditZoneId]',
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
        <ActivityIndicator color={theme.color.ink} />
      </Screen>
    );
  }

  const zonesInAudit = auditZones.data ?? [];
  const usedZoneIds = new Set(zonesInAudit.map((zone) => zone.zoneId));
  const remaining = (available.data ?? []).filter((zone) => !usedZoneIds.has(zone.id));
  const allComplete = zonesInAudit.length > 0 && zonesInAudit.every((z) => z.status === 'COMPLETED');
  const paused = audit.data?.status === 'PAUSED';
  const walkBy = audit.data?.auditType === 'WALK_BY';
  const canAddZone =
    audit.data?.status !== 'COMPLETED' && (zonesInAudit.length === 0 || allComplete);
  const leaderChoices = Array.from(
    new Map(
      (available.data ?? [])
        .filter((zone) => zone.zoneLeaderId && zone.zoneLeaderName)
        .map((zone) => [zone.zoneLeaderId!, { id: zone.zoneLeaderId!, name: zone.zoneLeaderName! }]),
    ).values(),
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Audit' }} />

      {paused && cursor.data?.auditZoneId ? (
        <Card style={styles.resumeBanner}>
          <Text style={styles.resumeText}>
            {walkBy
              ? 'Paused — your photographs and remarks are saved on this device'
              : `Paused — ${cursor.data.answered} question${cursor.data.answered === 1 ? '' : 's'} answered in this Zone`}
          </Text>
          <Button title="Resume" busy={resume.isPending} onPress={() => resume.mutate()} />
        </Card>
      ) : null}

      <FlatList
        data={zonesInAudit}
        keyExtractor={(zone) => zone.id}
        ListEmptyComponent={
          <EmptyState
            title="No Zones yet"
            detail={walkBy ? 'Select the first Zone to begin the walk-by.' : 'Add the first Zone to begin the questionnaire.'}
          />
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
                    pathname: walkBy ? '/walk-by/[auditZoneId]' : '/audit/[auditZoneId]',
                    params: { auditZoneId: item.id },
                  })
                }
              />
            </View>
          </Card>
        )}
        ListFooterComponent={
          <View style={styles.footer}>
            {remaining.length > 0 && canAddZone ? (
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
                        onPress={() =>
                          walkBy
                            ? setWalkBySetup({
                                zoneId: zone.id,
                                description: zone.description ?? '',
                                leaderId: zone.zoneLeaderId,
                              })
                            : addZone.mutate({ zoneId: zone.id })
                        }
                      />
                    </View>
                  </Card>
                ))}
              </>
            ) : null}

            {walkBySetup ? (
              <Card style={styles.setupCard}>
                <Text style={styles.name}>Describe and confirm this Zone</Text>
                <Text style={styles.fieldLabel}>Description (optional)</Text>
                <TextInput
                  multiline
                  style={styles.input}
                  value={walkBySetup.description}
                  onChangeText={(description) =>
                    setWalkBySetup((current) => current && { ...current, description })
                  }
                  placeholder="What are you walking through?"
                  placeholderTextColor={theme.color.ink2}
                />
                <Text style={styles.fieldLabel}>Zone leader</Text>
                {leaderChoices.length === 0 ? <Muted>No Zone Leader is recorded for this Unit.</Muted> : null}
                {leaderChoices.map((leader) => (
                  <Pressable
                    key={leader.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: walkBySetup.leaderId === leader.id }}
                    onPress={() =>
                      setWalkBySetup((current) => current && { ...current, leaderId: leader.id })
                    }
                    style={[
                      styles.leaderChoice,
                      walkBySetup.leaderId === leader.id && styles.leaderChoiceSelected,
                    ]}
                  >
                    <Text style={styles.leaderText}>{leader.name}</Text>
                  </Pressable>
                ))}
                <Button
                  title="Open camera"
                  busy={addZone.isPending}
                  onPress={() =>
                    addZone.mutate({
                      zoneId: walkBySetup.zoneId,
                      zoneDescription: walkBySetup.description.trim() || null,
                      ...(walkBySetup.leaderId
                        ? { zoneLeaderUserId: walkBySetup.leaderId }
                        : {}),
                    })
                  }
                />
                <Button title="Cancel" variant="secondary" onPress={() => setWalkBySetup(null)} />
              </Card>
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

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  name: { fontFamily: theme.family.bold, fontSize: theme.font.panel, color: theme.color.ink, textTransform: 'uppercase' },
  action: { marginTop: theme.space.sm },
  footer: { gap: theme.space.sm, marginTop: theme.space.lg },
  sectionTitle: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.label,
    color: theme.color.ink3,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
  },
  resumeBanner: { backgroundColor: theme.color.slip, borderColor: theme.color.edge, borderLeftWidth: 6 },
  resumeText: { fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.slipInk, marginBottom: theme.space.sm },
  setupCard: { gap: theme.space.sm, borderColor: theme.color.accent, borderWidth: 2 },
  fieldLabel: { fontFamily: theme.family.medium, fontSize: theme.font.label, color: theme.color.ink3, textTransform: 'uppercase', letterSpacing: 1.1 },
  input: {
    minHeight: 88,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    padding: theme.space.md,
    fontFamily: theme.family.regular,
    color: theme.color.ink,
    backgroundColor: theme.color.tile2,
    textAlignVertical: 'top',
  },
  leaderChoice: {
    minHeight: 48,
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    padding: theme.space.md,
  },
  leaderChoiceSelected: { borderColor: theme.color.accent, borderLeftWidth: 6, backgroundColor: theme.color.accentSoft },
  leaderText: { color: theme.color.ink, fontFamily: theme.family.medium },
}));
