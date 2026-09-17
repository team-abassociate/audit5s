import { useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ZONE_NUMBER_MAX, ZONE_NUMBER_MIN } from '@audit5s/contracts';
import { zoneCodeChoices, zoneCodeForNumber, zoneDisplayLabel } from '@audit5s/domain';
import {
  ActionBar,
  Button,
  Card,
  CardHeader,
  ChoiceList,
  Chip,
  EmptyState,
  ErrorBanner,
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
import {
  listLocalChecklistVersions,
  listLocalZones as listCatalogueZones,
} from '../../../lib/db/catalogue.repository';
import { useLocalDatabase } from '../../../lib/db/provider';
import { createThemedStyles, useTheme } from '../../../lib/theme';

type CatalogueZone = Awaited<ReturnType<typeof listCatalogueZones>>[number];

/**
 * The Zones of one audit: what has been done, what is next, and the way back in.
 *
 * Adding a Zone is a form (R-19): Zone 1…100 from a dropdown, an optional description, the
 * Zone Leader's name, and — on a scored audit — the department whose fifty questions follow.
 * A number the Unit already uses fills in what the catalogue knows; any other number is a
 * new Zone, which the server adds to the Unit when this audit syncs.
 *
 * The resume banner of §9.8 is rendered from the local cursors, so reopening an audit
 * aborted three days ago costs no round trip.
 */
export default function AuditZonesScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [zoneNumber, setZoneNumber] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [leaderName, setLeaderName] = useState('');
  const [versionId, setVersionId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const audit = useQuery({
    queryKey: ['local', 'audit', auditId],
    queryFn: async () => (await getLocalAudit(database, auditId))[0] ?? null,
  });

  const auditZones = useQuery({
    queryKey: ['local', 'audit-zones', auditId],
    queryFn: () => listLocalAuditZones(database, auditId),
  });

  const catalogueZones = useQuery({
    enabled: Boolean(audit.data?.unitId),
    queryKey: ['local', 'zones', audit.data?.unitId],
    queryFn: () => listCatalogueZones(database, audit.data!.unitId),
  });

  const versions = useQuery({
    queryKey: ['local', 'checklist-versions'],
    queryFn: () => listLocalChecklistVersions(database),
  });

  const cursor = useQuery({
    queryKey: ['local', 'cursor', auditId],
    queryFn: () => resumeCursor(database, auditId),
  });

  const walkBy = audit.data?.auditType === 'WALK_BY';

  const addZone = useMutation({
    mutationFn: (input: { zoneNumber: number; checklistVersionId: string | null }) =>
      addLocalZone(database, {
        auditId,
        zoneNumber: input.zoneNumber,
        sequenceNo: (auditZones.data?.length ?? 0) + 1,
        checklistVersionId: input.checklistVersionId,
        zoneDescription: description,
        zoneLeaderName: leaderName,
      }),
    onSuccess: async (auditZoneId) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      setZoneNumber(null);
      setDescription('');
      setLeaderName('');
      setVersionId(null);
      setShowErrors(false);
      router.push({
        pathname: walkBy ? '/walk-by/[auditZoneId]' : '/audit/[auditZoneId]',
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
          pathname: walkBy ? '/walk-by/[auditZoneId]' : '/audit/[auditZoneId]',
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
  const usedCodes = new Set(zonesInAudit.map((zone) => zone.zoneCodeSnapshot));
  const byCode = new Map((catalogueZones.data ?? []).map((zone) => [zone.code, zone]));
  const allComplete = zonesInAudit.length > 0 && zonesInAudit.every((z) => z.status === 'COMPLETED');
  const paused = audit.data?.status === 'PAUSED';
  const canAddZone =
    audit.data?.status !== 'COMPLETED' && (zonesInAudit.length === 0 || allComplete);

  const finished = zonesInAudit.filter((zone) => zone.status === 'COMPLETED').length;
  const canFinish = allComplete && audit.data?.status !== 'COMPLETED';
  const canAbort = audit.data?.status === 'IN_PROGRESS';

  const selected = zoneNumber === null ? null : byCode.get(zoneCodeForNumber(zoneNumber));
  const errors = {
    zone: zoneNumber === null ? 'Choose the Zone' : null,
    leader: leaderName.trim() === '' ? 'Enter the Zone Leader’s name' : null,
    department: !walkBy && !versionId ? 'Choose the department' : null,
  };

  // A number the Unit already uses brings what the catalogue knows about it, without
  // overwriting anything the auditor has already typed.
  const chooseZone = (number: number) => {
    setZoneNumber(number);
    const known = byCode.get(zoneCodeForNumber(number));
    if (!known) return;
    if (description.trim() === '' && known.description) setDescription(known.description);
    if (leaderName.trim() === '' && known.zoneLeaderName) setLeaderName(known.zoneLeaderName);
    if (!versionId && known.defaultChecklistTemplateId) {
      const match = (versions.data ?? []).find(
        (version) => version.templateId === known.defaultChecklistTemplateId,
      );
      if (match) setVersionId(match.id);
    }
  };

  const submit = () => {
    if (zoneNumber === null || errors.leader || errors.department) {
      setShowErrors(true);
      return;
    }
    addZone.mutate({ zoneNumber, checklistVersionId: walkBy ? null : versionId });
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: walkBy ? 'Walk-by' : 'Audit' }} />

      <FlatList
        data={zonesInAudit}
        keyExtractor={(zone) => zone.id}
        keyboardShouldPersistTaps="handled"
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
            {zonesInAudit.length > 0 ? (
              <SectionHead title="Zones in this audit" description={`${finished} of ${zonesInAudit.length} finished`} />
            ) : null}
          </>
        }
        ListEmptyComponent={
          canAddZone ? null : (
            <EmptyState title="No Zones" detail="This audit has no Zones." />
          )
        }
        renderItem={({ item }) => (
          <Card>
            <CardHeader
              title={zoneDisplayLabel(item.zoneCodeSnapshot, item.zoneNameSnapshot)}
              description={
                [item.checklistTemplateNameSnapshot, item.zoneLeaderNameSnapshot && `Leader ${item.zoneLeaderNameSnapshot}`]
                  .filter(Boolean)
                  .join(' · ') || null
              }
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
            {canAddZone ? (
              <Card>
                <CardHeader
                  title={zonesInAudit.length === 0 ? 'Create the Zone' : 'Add the next Zone'}
                  description={
                    walkBy
                      ? 'Where the walk-by goes, and who leads it.'
                      : 'Each Zone is its own questionnaire of the department you choose.'
                  }
                />

                <Label>Zone</Label>
                <Pressable
                  testID="zone-number"
                  accessibilityRole="button"
                  accessibilityLabel="Choose the Zone"
                  onPress={() => setPicking(true)}
                  style={[styles.select, showErrors && errors.zone ? styles.selectError : null]}
                >
                  <Text style={zoneNumber === null ? styles.selectPlaceholder : styles.selectValue}>
                    {zoneNumber === null
                      ? `Choose Zone ${ZONE_NUMBER_MIN} to ${ZONE_NUMBER_MAX}`
                      : selected
                        ? zoneDisplayLabel(selected.code, selected.name)
                        : `Zone ${zoneNumber} (new)`}
                  </Text>
                  <Text style={styles.selectChevron}>▾</Text>
                </Pressable>
                {showErrors && errors.zone ? <Text style={styles.error}>{errors.zone}</Text> : null}

                <Field
                  label="Zone description (optional)"
                  multiline
                  value={description}
                  onChangeText={setDescription}
                  placeholder="What this Zone covers"
                  containerStyle={styles.gapAbove}
                />

                <Field
                  testID="zone-leader-name"
                  label="Zone Leader’s name"
                  value={leaderName}
                  onChangeText={setLeaderName}
                  placeholder="Full name"
                  autoCapitalize="words"
                  error={showErrors && errors.leader ? errors.leader : undefined}
                />

                {!walkBy ? (
                  <>
                    <Label>Department</Label>
                    <ChoiceList
                      options={(versions.data ?? []).map((version) => ({
                        value: version.id,
                        label: version.templateName,
                        detail: `${version.totalQuestions} questions`,
                      }))}
                      value={versionId}
                      onChange={setVersionId}
                      empty="No department checklists on this device yet. Pull down on Units to refresh."
                    />
                    {showErrors && errors.department ? (
                      <Text style={styles.error}>{errors.department}</Text>
                    ) : null}
                  </>
                ) : null}

                <ErrorBanner message={addZone.error ? addZone.error.message : null} />

                <Button
                  testID="start-zone"
                  title={walkBy ? 'Open camera' : 'Start the questions'}
                  busy={addZone.isPending}
                  onPress={submit}
                />
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

      <ZonePicker
        visible={picking}
        usedCodes={usedCodes}
        byCode={byCode}
        onPick={chooseZone}
        onClose={() => setPicking(false)}
      />
    </Screen>
  );
}

/**
 * The Zone 1…100 dropdown: a ruled sheet from the bottom edge, within thumb reach. A Zone
 * already in this audit reads "Already in this audit" and cannot be chosen again (§5.5).
 */
function ZonePicker({
  visible,
  usedCodes,
  byCode,
  onPick,
  onClose,
}: {
  visible: boolean;
  usedCodes: ReadonlySet<string>;
  byCode: ReadonlyMap<string, CatalogueZone>;
  onPick: (zoneNumber: number) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: 14 + insets.bottom }]}>
        <Text style={styles.sheetTitle} accessibilityRole="header">
          Choose the Zone
        </Text>
        <FlatList
          data={zoneCodeChoices()}
          keyExtractor={(choice) => choice.code}
          style={styles.sheetList}
          initialNumToRender={20}
          renderItem={({ item }) => {
            const taken = usedCodes.has(item.code);
            const known = byCode.get(item.code);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: taken }}
                disabled={taken}
                onPress={() => {
                  onClose();
                  onPick(item.number);
                }}
                style={({ pressed }) => [styles.sheetRow, taken && styles.sheetRowTaken, pressed && styles.pressed]}
              >
                <Text style={[styles.sheetLabel, taken && styles.sheetLabelTaken]}>
                  {known ? zoneDisplayLabel(known.code, known.name) : `Zone ${item.number}`}
                </Text>
                {taken ? (
                  <Text style={styles.sheetDetail}>Already in this audit</Text>
                ) : known?.zoneLeaderName ? (
                  <Text style={styles.sheetDetail}>Leader {known.zoneLeaderName}</Text>
                ) : null}
              </Pressable>
            );
          }}
        />
        <Button title="Cancel" variant="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  footer: { gap: theme.space.sm, marginTop: theme.space.lg, paddingBottom: theme.space.md },
  slipAction: { marginTop: theme.space.xs },
  gapAbove: { marginTop: theme.space.md },
  select: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
    paddingHorizontal: theme.space.md,
  },
  selectError: { borderColor: theme.color.critBand, borderLeftWidth: 4 },
  selectValue: { fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
  selectPlaceholder: { fontFamily: theme.family.regular, fontSize: theme.font.base, color: theme.color.ink3 },
  selectChevron: { fontFamily: theme.family.bold, fontSize: theme.font.base, color: theme.color.ink2 },
  error: {
    fontFamily: theme.family.medium,
    fontSize: 12.5,
    color: theme.color.critBand,
    marginTop: 4,
    marginBottom: theme.space.sm,
  },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.color.hard },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '80%',
    backgroundColor: theme.color.tile,
    borderTopWidth: 2,
    borderTopColor: theme.color.edge,
    padding: theme.space.md,
    gap: theme.space.sm,
  },
  sheetTitle: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.32,
  },
  sheetList: { flexGrow: 0 },
  sheetRow: {
    minHeight: 52,
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
    paddingVertical: 8,
    paddingHorizontal: theme.space.md,
    marginBottom: theme.space.xs,
  },
  sheetRowTaken: { backgroundColor: theme.color.tile2 },
  sheetLabel: { fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
  sheetLabelTaken: { color: theme.color.ink3 },
  sheetDetail: { fontFamily: theme.family.regular, fontSize: 12.5, color: theme.color.ink2, marginTop: 2 },
  pressed: { transform: [{ translateX: 3 }, { translateY: 3 }] },
}));
