import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ZONE_NUMBER_MAX, ZONE_NUMBER_MIN, type ZoneLock, type ZoneLocksResponse } from '@audit5s/contracts';
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
import { api } from '../../../lib/api';
import { createThemedStyles, useTheme } from '../../../lib/theme';

type CatalogueZone = Awaited<ReturnType<typeof listCatalogueZones>>[number];

/**
 * What has been typed for one Zone but not yet saved.
 *
 * Kept per Zone number rather than in three fields shared by the form, because the form is
 * reused for every Zone in the audit and the fields are *about* the Zone. Choosing Zone 4
 * after typing Zone 1's leader used to leave Zone 1's leader on screen, where the next tap
 * would have saved it against Zone 4 — a wrong name on a report, from a silent default.
 * Now each Zone keeps its own draft: switching away puts it down, switching back picks it
 * up, and a Zone nobody has typed anything for starts empty.
 */
interface ZoneDraft {
  description: string;
  leaderName: string;
  versionId: string | null;
}

const EMPTY_DRAFT: ZoneDraft = { description: '', leaderName: '', versionId: null };

/** The slot for what is typed before any Zone is chosen; it follows the first choice. */
const NO_ZONE = -1;

function isEmptyDraft(draft: ZoneDraft): boolean {
  return draft.description.trim() === '' && draft.leaderName.trim() === '' && !draft.versionId;
}

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
  const [drafts, setDrafts] = useState<Record<number, ZoneDraft>>({});
  const [picking, setPicking] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  const draftKey = zoneNumber ?? NO_ZONE;
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  const editDraft = (change: Partial<ZoneDraft>) =>
    setDrafts((current) => ({
      ...current,
      [draftKey]: { ...(current[draftKey] ?? EMPTY_DRAFT), ...change },
    }));

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

  /**
   * R-29: the Zones another open audit of this Unit is already holding.
   *
   * The one query on this screen that needs the network, and the only one allowed to fail
   * quietly. A Unit assigned to two Consultants can have both of them in the plant at once,
   * and a Zone one of them is auditing is a Zone the other must not audit too. The server
   * refuses it whenever the item reaches it; this read is what lets the picker say so
   * before forty minutes of questions rather than after.
   *
   * Offline it simply returns nothing and the picker shows no locks — the app does not stop
   * working because a courtesy could not be fetched, and the refusal still arrives on sync
   * with the work intact.
   */
  const zoneLocks = useQuery({
    queryKey: ['audits', auditId, 'zone-locks'],
    queryFn: () => api.get<ZoneLocksResponse>(`/audits/${auditId}/zone-locks`),
    enabled: audit.data?.status === 'IN_PROGRESS' || audit.data?.status === 'READY',
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const walkBy = audit.data?.auditType === 'WALK_BY';

  const addZone = useMutation({
    mutationFn: (input: { zoneNumber: number; draft: ZoneDraft }) =>
      addLocalZone(database, {
        auditId,
        zoneNumber: input.zoneNumber,
        sequenceNo: (auditZones.data?.length ?? 0) + 1,
        checklistVersionId: walkBy ? null : input.draft.versionId,
        zoneDescription: input.draft.description,
        zoneLeaderName: input.draft.leaderName,
      }),
    onSuccess: async (auditZoneId, input) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      // The Zone is in the audit now, so its draft has nowhere left to go back to.
      setDrafts((current) => {
        const next = { ...current };
        delete next[input.zoneNumber];
        return next;
      });
      setZoneNumber(null);
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

  /**
   * Leaving the audit, in the two senses an auditor means it (N7).
   *
   * Both save and both pause — nothing on this screen discards anything, and the only
   * status that voids an audit is a Super Admin's cancellation (A-1). What differs is the
   * reason recorded on the pause, which rides the outbox to the Super Admin's
   * notification: a break for lunch and an audit called off are not the same event, and
   * before this the app could only report the second.
   */
  const leave = useMutation({
    mutationFn: (reason: string | null) => pauseLocalAudit(database, auditId, reason),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      router.back();
    },
  });

  const confirmAbort = () =>
    Alert.alert(
      'Abort this audit?',
      'Everything you have recorded is kept on this device and synced as usual. The audit ' +
        'is paused and the Super Admin is told it was aborted. You can still reopen it.',
      [
        { text: 'Keep auditing', style: 'cancel' },
        { text: 'Abort', style: 'destructive', onPress: () => leave.mutate('Aborted by auditor') },
      ],
    );

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
  // Both ways of leaving need an audit that is actually running; a paused one has already
  // been left, and the Resume slip above is what it offers instead.
  const canPause = audit.data?.status === 'IN_PROGRESS';

  const selected = zoneNumber === null ? null : byCode.get(zoneCodeForNumber(zoneNumber));
  const lockedByCode = new Map((zoneLocks.data?.locks ?? []).map((lock) => [lock.zoneCode, lock]));
  const lockOnSelection = zoneNumber === null ? null : lockedByCode.get(zoneCodeForNumber(zoneNumber));
  const errors = {
    zone: zoneNumber === null ? 'Choose the Zone' : null,
    leader: draft.leaderName.trim() === '' ? 'Enter the Zone Leader’s name' : null,
    department: !walkBy && !draft.versionId ? 'Choose the department' : null,
  };

  /**
   * Choosing a Zone puts down the draft of the one being left and picks up that Zone's own.
   *
   * A Zone chosen for the first time starts from what the Unit's catalogue knows about it —
   * its description, its leader, its usual department — because those are facts about *this*
   * Zone rather than leftovers from the last one. What was typed before any Zone was chosen
   * follows the first choice rather than being thrown away, and never overwrites the
   * catalogue's answer for a Zone chosen later.
   */
  const chooseZone = (number: number) => {
    setDrafts((current) => {
      if (current[number]) return current;

      const known = byCode.get(zoneCodeForNumber(number));
      const carried = current[NO_ZONE];
      const carry = carried && !isEmptyDraft(carried) ? carried : null;
      const template = known?.defaultChecklistTemplateId
        ? (versions.data ?? []).find(
            (version) => version.templateId === known.defaultChecklistTemplateId,
          )
        : undefined;

      const next = { ...current };
      delete next[NO_ZONE];
      next[number] = {
        description: carry?.description.trim() ? carry.description : (known?.description ?? ''),
        leaderName: carry?.leaderName.trim() ? carry.leaderName : (known?.zoneLeaderName ?? ''),
        versionId: carry?.versionId ?? template?.id ?? null,
      };
      return next;
    });
    setZoneNumber(number);
    setShowErrors(false);
  };

  const submit = () => {
    if (zoneNumber === null || errors.leader || errors.department || lockOnSelection) {
      setShowErrors(true);
      return;
    }
    addZone.mutate({ zoneNumber, draft });
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

                {/* R-29, said before the questions rather than after them. */}
                {lockOnSelection ? (
                  <Slip title="That Zone is taken">
                    <SlipText>
                      {lockOnSelection.auditorName} is auditing Zone {lockOnSelection.zoneCode} —{' '}
                      {lockOnSelection.zoneName} in another audit of this Unit. Choose a
                      different Zone; nothing you have recorded is lost.
                    </SlipText>
                  </Slip>
                ) : null}

                <Field
                  label="Zone description (optional)"
                  multiline
                  value={draft.description}
                  onChangeText={(value) => editDraft({ description: value })}
                  placeholder="What this Zone covers"
                  containerStyle={styles.gapAbove}
                />

                <Field
                  testID="zone-leader-name"
                  label="Zone Leader’s name"
                  value={draft.leaderName}
                  onChangeText={(value) => editDraft({ leaderName: value })}
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
                      value={draft.versionId}
                      onChange={(value) => editDraft({ versionId: value })}
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

      {/*
        Three ways out, side by side, because they are alternatives rather than one action
        with a fallback: put it down for now, call it off, or declare it finished. Stacking
        them made the middle one look like a lesser version of the one above it, and
        "Abort — save and pause" was one button trying to be two.
      */}
      {canFinish || canPause ? (
        <ActionBar row>
          {canPause ? (
            <Button
              title="Save & pause"
              variant="secondary"
              busy={leave.isPending && leave.variables === null}
              onPress={() => leave.mutate(null)}
            />
          ) : null}
          {canPause ? (
            <Button
              title="Abort"
              variant="danger"
              busy={leave.isPending && leave.variables !== null}
              onPress={confirmAbort}
            />
          ) : null}
          {/*
            Present from the first Zone, and inert until every Zone is finished — the rule
            §7.1 already enforces. A button that appears only at the end hides what the end
            *is*; one that is visibly not yet available says it.
          */}
          <Button
            title="Finish audit"
            disabled={!canFinish}
            busy={finish.isPending}
            onPress={() => finish.mutate()}
          />
        </ActionBar>
      ) : null}

      <ZonePicker
        visible={picking}
        usedCodes={usedCodes}
        byCode={byCode}
        lockedByCode={lockedByCode}
        onPick={chooseZone}
        onClose={() => setPicking(false)}
      />
    </Screen>
  );
}

/**
 * The Zone 1…100 dropdown: a ruled sheet from the bottom edge, within thumb reach.
 *
 * Two kinds of Zone cannot be chosen, and the row says which it is rather than only going
 * grey. One is already in this audit (§5.5). The other is in somebody else's open audit of
 * this Unit (R-29) — that row names the auditor holding it, because "taken" with no name
 * is the kind of refusal that ends in a phone call to the office.
 */
function ZonePicker({
  visible,
  usedCodes,
  byCode,
  lockedByCode,
  onPick,
  onClose,
}: {
  visible: boolean;
  usedCodes: ReadonlySet<string>;
  byCode: ReadonlyMap<string, CatalogueZone>;
  lockedByCode: ReadonlyMap<string, ZoneLock>;
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
            const inThisAudit = usedCodes.has(item.code);
            const lock = lockedByCode.get(item.code);
            const taken = inThisAudit || lock !== undefined;
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
                {inThisAudit ? (
                  <Text style={styles.sheetDetail}>Already in this audit</Text>
                ) : lock ? (
                  <Text style={styles.sheetDetail}>Being audited by {lock.auditorName}</Text>
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
