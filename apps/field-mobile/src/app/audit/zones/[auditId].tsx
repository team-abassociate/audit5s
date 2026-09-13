import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { zoneDisplayLabel } from '@audit5s/domain';
import {
  ActionBar,
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Field,
  Label,
  Muted,
  Screen,
  SectionHead,
  Slip,
  SlipText,
} from '../../../components/ui';
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

  const finished = zonesInAudit.filter((zone) => zone.status === 'COMPLETED').length;
  const canFinish = allComplete && audit.data?.status !== 'COMPLETED';
  const canAbort = audit.data?.status === 'IN_PROGRESS';

  return (
    <Screen>
      <Stack.Screen options={{ title: walkBy ? 'Walk-by' : 'Audit' }} />

      <FlatList
        data={zonesInAudit}
        keyExtractor={(zone) => zone.id}
        ListHeaderComponent={
          <>
            {/* The one slip on this screen: a paused audit is waiting for the auditor. */}
            {paused && cursor.data?.auditZoneId ? (
              <Slip title="Paused">
                <SlipText>
                  {walkBy
                    ? 'Your photographs and remarks are saved on this device.'
                    : `${cursor.data.answered} question${cursor.data.answered === 1 ? '' : 's'} answered in this Zone. Resume where you stopped.`}
                </SlipText>
                <View style={styles.slipAction}>
                  <Button title="Resume" busy={resume.isPending} onPress={() => resume.mutate()} />
                </View>
              </Slip>
            ) : null}
            <SectionHead
              title="Zones in this audit"
              description={zonesInAudit.length > 0 ? `${finished} of ${zonesInAudit.length} finished` : null}
            />
          </>
        }
        ListEmptyComponent={
          <EmptyState
            title="No Zones yet"
            detail={walkBy ? 'Select the first Zone to begin the walk-by.' : 'Add the first Zone to begin the questionnaire.'}
          />
        }
        renderItem={({ item }) => (
          <Card>
            <CardHeader
              title={zoneDisplayLabel(item.zoneCodeSnapshot, item.zoneNameSnapshot)}
              action={
                <Chip tone={item.status === 'COMPLETED' ? 'ok' : item.status === 'DRAFT' ? 'muted' : 'warn'}>
                  {item.status === 'COMPLETED' ? 'Finished' : item.status === 'DRAFT' ? 'Not started' : 'In progress'}
                </Chip>
              }
            />
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
          </Card>
        )}
        ListFooterComponent={
          <View style={styles.footer}>
            {remaining.length > 0 && canAddZone ? (
              <>
                <SectionHead
                  title="Add next Zone"
                  description={walkBy ? 'Choose where the walk-by goes next.' : 'Each Zone is its own questionnaire.'}
                />
                {remaining.map((zone) => (
                  <Card key={zone.id}>
                    <CardHeader title={zoneDisplayLabel(zone.code, zone.name)} description={zone.description} />
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
                  </Card>
                ))}
              </>
            ) : null}

            {walkBySetup ? (
              <Card>
                <CardHeader title="Describe and confirm this Zone" />
                <Field
                  label="Description (optional)"
                  multiline
                  value={walkBySetup.description}
                  onChangeText={(description) =>
                    setWalkBySetup((current) => current && { ...current, description })
                  }
                  placeholder="What are you walking through?"
                />
                <Label>Zone leader</Label>
                {leaderChoices.length === 0 ? <Muted>No Zone Leader is recorded for this Unit.</Muted> : null}
                <View style={styles.choices} accessibilityRole="radiogroup">
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
                </View>
                <View style={styles.stack}>
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
                </View>
              </Card>
            ) : null}

            <Muted>
              Saved on this device. Nothing here waits for a connection, and nothing is lost
              without one.
            </Muted>
          </View>
        }
      />

      {canFinish || canAbort ? (
        <ActionBar>
          {canFinish ? (
            <Button title="Finish audit" busy={finish.isPending} onPress={() => finish.mutate()} />
          ) : null}
          {canAbort ? (
            <Button title="Abort — save and pause" variant="secondary" onPress={() => abort.mutate()} />
          ) : null}
        </ActionBar>
      ) : null}
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  footer: { gap: theme.space.sm, marginTop: theme.space.lg, paddingBottom: theme.space.md },
  slipAction: { marginTop: theme.space.xs },
  stack: { gap: theme.space.sm },
  choices: { gap: theme.space.sm, marginBottom: theme.space.md },
  leaderChoice: {
    minHeight: 48,
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
    padding: theme.space.md,
  },
  // Selection is the one place the accent belongs (GEMBA-BOARD.md non-negotiable 6).
  leaderChoiceSelected: { borderColor: theme.color.accent, borderLeftWidth: 6, backgroundColor: theme.color.accentSoft },
  leaderText: { color: theme.color.ink, fontFamily: theme.family.medium },
}));
