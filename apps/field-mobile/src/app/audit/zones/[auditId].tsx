import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ZoneLock, ZoneLocksResponse } from '@audit5s/contracts';
import { MAX_AUDIT_RESTARTS, mayAddZoneWhileAuditing, restartsRemaining, zoneCodeForLabel, zoneDisplayLabel } from '@audit5s/domain';
import {
  Button,
  Card,
  CardHeader,
  ChoiceList,
  Chip,
  EmptyState,
  ErrorBanner,
  Field,
  HeaderAction,
  Label,
  ConfirmAction,
  Muted,
  Screen,
  SectionHead,
  Slip,
  SlipText,
  useSheetInset,
} from '../../../components/ui';
import {
  abortLocalAudit,
  addLocalZone,
  completeLocalAudit,
  discardLocalAuditIfEmpty,
  editLocalZone,
  getLocalAudit,
  restartLocalAudit,
  listLocalAuditZones,
  pauseLocalAudit,
  renameLocalZone,
  withdrawLocalZone,
  resumeCursor,
  resumeLocalAudit,
} from '../../../lib/db/audit.repository';
import {
  listLocalChecklistVersions,
  listLocalZones as listCatalogueZones,
  unitHasZoneList,
} from '../../../lib/db/catalogue.repository';
import { useLocalDatabase } from '../../../lib/db/provider';
import { api, problemMessage } from '../../../lib/api';
import { createThemedStyles, useTheme } from '../../../lib/theme';
import { leaveScreen } from '../../../lib/leave-screen';
import { useRequiredFields } from '../../../lib/required-fields';
import { useSession } from '../../../lib/session';
import { ZoneNumberField } from '../../../components/zone-number-field';
import { useSelfieCheck } from '../../../components/selfie-check';

type CatalogueZone = Awaited<ReturnType<typeof listCatalogueZones>>[number];

/** What is being corrected on one Zone (R-34), while the sheet is open. */
interface ZoneEdit {
  auditZoneId: string;
  label: string;
  description: string;
  leaderName: string;
}

/** The server's floor for a restart justification, mirrored so the button can gate on it. */
const MIN_RESTART_REASON = 10;

/**
 * What has been typed for one Zone but not yet saved.
 *
 * Kept per Zone rather than in three fields shared by the form, because the form is
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
const NO_ZONE = '';
/** The slot for a Zone being added here (R-52), whatever label it ends up with. */
const NEW_ZONE = '+new';

/** R-52: a Zone added during the audit — its label (`1A`, at most 3) and its name. */
interface NewZone {
  label: string;
  name: string;
}

function isEmptyDraft(draft: ZoneDraft): boolean {
  return draft.description.trim() === '' && draft.leaderName.trim() === '' && !draft.versionId;
}

/**
 * The Zones of one audit: what has been done, what is next, and the way back in.
 *
 * An audit covers one Zone (owner, 2026-10-12): submitting it finishes the audit
 * (`completeLocalZone`), so there is no Finish here.
 *
 * Adding a Zone is a form (R-19): the Zone from a dropdown of the Unit's own Zones, an
 * optional description, the Zone Leader's name, and — on a scored audit — the department
 * whose fifty questions follow. Choosing a Zone fills in what the catalogue knows.
 *
 * R-52: only a Super Admin or a Coordinator adds a Zone here — "+ New Zone" opens its label
 * (at most three letters or digits) and name on one line — and the server adds it to the
 * Unit when this audit syncs. R-59: so does a Consultant, while the Unit has no imported
 * Zone list. Everyone else picks from the list.
 *
 * The resume banner of §9.8 is rendered from the local cursors, so reopening an audit
 * aborted three days ago costs no round trip.
 */
export default function AuditZonesScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const params = useLocalSearchParams<{ auditId: string; zoneId?: string }>();
  const auditId = params.auditId;
  // A cross-audit call's Zone (`?zoneId=`), chosen once the catalogue is in; then forgotten.
  const [presetZoneId, setPresetZoneId] = useState(params.zoneId ?? null);
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();

  // Back before a Zone is chosen means no audit (owner, 2026-10-14): the selfie-only audit
  // goes, so the next Audit tap is a fresh selfie, not "carry on or start a new one?".
  const navigation = useNavigation();
  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        void discardLocalAuditIfEmpty(database, auditId).then((gone) => {
          if (gone) void queryClient.invalidateQueries({ queryKey: ['local'] });
        });
      }),
    [navigation, database, auditId, queryClient],
  );

  const { can, scope } = useSession();
  const [zoneCode, setZoneCode] = useState<string | null>(null);
  const [newZone, setNewZone] = useState<NewZone | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ZoneDraft>>({});
  const [picking, setPicking] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const required = useRequiredFields<'zone' | 'leader' | 'department'>();

  const draftKey = newZone ? NEW_ZONE : (zoneCode ?? NO_ZONE);
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

  // Narrowed to the Unit's industry (0042), so a hospital is never offered a press shop.
  const zoneList = useQuery({
    enabled: Boolean(audit.data?.unitId),
    queryKey: ['local', 'zone-list', audit.data?.unitId],
    queryFn: () => unitHasZoneList(database, audit.data!.unitId),
  });
  // R-59: a Consultant adds Zones only to a Unit nobody has imported a Zone list for.
  const mayAddZone = mayAddZoneWhileAuditing(scope?.role, zoneList.data ?? true);
  const versions = useQuery({
    enabled: Boolean(audit.data?.unitId),
    queryKey: ['local', 'checklist-versions', audit.data?.unitId],
    queryFn: () => listLocalChecklistVersions(database, audit.data!.unitId),
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
    mutationFn: (input: { zoneCode: string; zoneName: string | null; draftKey: string; draft: ZoneDraft }) =>
      addLocalZone(database, {
        auditId,
        zoneCode: input.zoneCode,
        zoneName: input.zoneName,
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
        delete next[input.draftKey];
        return next;
      });
      setZoneCode(null);
      setNewZone(null);
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
    onSuccess: () => {
      leaveScreen(
        () => router.back(),
        () => void queryClient.invalidateQueries({ queryKey: ['local'] }),
      );
    },
  });

  // Abort audit (owner, 2026-10-12): the whole audit goes, from this phone and every list.
  const abort = useMutation({
    mutationFn: () => abortLocalAudit(database, auditId),
    onSuccess: () =>
      leaveScreen(
        () => router.navigate('/overview'),
        () => void queryClient.invalidateQueries({ queryKey: ['local'] }),
      ),
  });
  const confirmAbort = () =>
    Alert.alert(
      'Abort this audit?',
      'The whole audit is removed: its answers and photographs, from In progress and from ' +
        'history. This cannot be undone.',
      [
        { text: 'Keep auditing', style: 'cancel' },
        { text: 'Abort audit', style: 'destructive', onPress: () => abort.mutate() },
      ],
    );

  const withdraw = useMutation({
    mutationFn: (auditZoneId: string) => withdrawLocalZone(database, auditZoneId, 'Aborted by auditor'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local'] }),
  });

  const finish = useMutation({
    mutationFn: () => completeLocalAudit(database, auditId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local'] }),
  });

  const [editing, setEditing] = useState<ZoneEdit | null>(null);
  const editZone = useMutation({
    mutationFn: (next: ZoneEdit) =>
      editLocalZone(database, {
        auditZoneId: next.auditZoneId,
        zoneDescription: next.description,
        zoneLeaderName: next.leaderName,
      }),
    onSuccess: () => {
      setEditing(null);
      return queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });

  /**
   * Renaming the Zone once the audit is done — "Zone 7" added in the field becomes "Press
   * shop". Online: the server renames the Unit's Zone, and the rename reaches every audit
   * of it, finished ones included (R-52).
   */
  const [renaming, setRenaming] = useState<{ zoneId: string; label: string; name: string } | null>(null);
  const rename = useMutation({
    mutationFn: async (next: { zoneId: string; name: string }) => {
      const zone = catalogueZones.data?.find((candidate) => candidate.id === next.zoneId);
      if (!zone) throw new Error('This Zone has not reached the server yet. Sync, then rename it.');
      const name = next.name.trim();
      await api.patch(`/zones/${zone.id}`, { name });
      await renameLocalZone(database, { unitId: audit.data!.unitId, code: zone.code, name });
    },
    onSuccess: () => {
      setRenaming(null);
      return queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });

  const [restartReason, setRestartReason] = useState<string | null>(null);
  const restart = useMutation({
    mutationFn: (reason: string) => restartLocalAudit(database, auditId, reason),
    onSuccess: () => {
      setRestartReason(null);
      return queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });

  // The selfie's notice, retake and Submit check (owner, 2026-10-24).
  const selfie = useSelfieCheck(auditId);

  /*
   * Only an audit begun before one-Zone-per-audit can be here with every Zone done and the
   * audit still open; Submit on a Zone finishes the audit now. It still asks, because a
   * finished audit's nonconformities become corrective actions somebody is chased for.
   */
  const confirmFinish = () =>
    Alert.alert(
      'Submit this audit?',
      `${finished} Zone(s) will be submitted and scored, and any nonconformity photographs ` +
        'become corrective actions.',
      [
        { text: 'Not yet', style: 'cancel' },
        { text: 'Submit audit', onPress: () => selfie.gate(() => finish.mutate()) },
      ],
    );

  if (audit.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.ink} />
      </Screen>
    );
  }
  if (selfie.camera) return selfie.camera;

  const zonesInAudit = auditZones.data ?? [];
  // A withdrawn Zone is still listed — it happened — but it is out of the audit: it does
  // not hold its Zone number, block the next Zone, or stand between the audit and Finish.
  const liveZones = zonesInAudit.filter((zone) => zone.status !== 'WITHDRAWN');
  const usedCodes = new Set(liveZones.map((zone) => zone.zoneCodeSnapshot));
  const byCode = new Map((catalogueZones.data ?? []).map((zone) => [zone.code, zone]));
  const allComplete = liveZones.length > 0 && liveZones.every((z) => z.status === 'COMPLETED');
  const paused = audit.data?.status === 'PAUSED';
  // A paused audit is resumed first: its Zones and its finish wait behind *Resume*, which
  // is what the server's state machine asks too — a paused audit cannot be finished.
  // One Zone per audit: once it is chosen, there is no next one to add.
  const canAddZone = audit.data?.status !== 'COMPLETED' && !paused && liveZones.length === 0;

  const finished = liveZones.filter((zone) => zone.status === 'COMPLETED').length;
  const canFinish = allComplete && audit.data?.status !== 'COMPLETED' && !paused;
  // Both ways of leaving need an audit that is actually running; a paused one has already
  // been left, and the Resume slip above is what it offers instead.
  const canPause = audit.data?.status === 'IN_PROGRESS';
  const canAbort = ['ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'].includes(audit.data?.status ?? '');
  /*
   * R-33: the way back, for the two chances the product owner settled on.
   *
   * Shown only on an audit this device has finished and only while chances remain —
   * a disabled button here would advertise a door that is shut for good, which the
   * Finish button can afford to do (it opens once the Zones are done) and this cannot.
   */
  const auditOpen =
    audit.data?.status === 'IN_PROGRESS' ||
    audit.data?.status === 'PAUSED' ||
    audit.data?.status === 'READY';
  const restartsLeft = restartsRemaining(audit.data?.restartCount ?? 0);
  const canRestart = audit.data?.status === 'COMPLETED' && restartsLeft > 0;

  const newCode = newZone ? zoneCodeForLabel(newZone.label) : null;
  const pickedCode = newZone ? newCode : zoneCode;
  const selected = zoneCode === null ? null : byCode.get(zoneCode);
  const lockedByCode = new Map((zoneLocks.data?.locks ?? []).map((lock) => [lock.zoneCode, lock]));
  const lockOnSelection = zoneCode === null || newZone ? null : lockedByCode.get(zoneCode);
  const errors = {
    zone: newZone
      ? newCode === null
        ? 'Type the Zone number, and its subzone letter if ticked'
        : byCode.has(newCode) || usedCodes.has(newCode)
          ? `Zone ${newZone.label} already exists. Choose it from the list.`
          : null
      : zoneCode === null
        ? 'Choose the Zone'
        : null,
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
  const chooseZone = (code: string) => {
    setDrafts((current) => {
      if (current[code]) return current;

      const known = byCode.get(code);
      const carried = current[NO_ZONE];
      const carry = carried && !isEmptyDraft(carried) ? carried : null;
      const template = known?.defaultChecklistTemplateId
        ? (versions.data ?? []).find(
            (version) => version.templateId === known.defaultChecklistTemplateId,
          )
        : undefined;

      const next = { ...current };
      delete next[NO_ZONE];
      next[code] = {
        description: carry?.description.trim() ? carry.description : (known?.description ?? ''),
        leaderName: carry?.leaderName.trim() ? carry.leaderName : (known?.zoneLeaderName ?? ''),
        versionId: carry?.versionId ?? template?.id ?? null,
      };
      return next;
    });
    setZoneCode(code);
    setNewZone(null);
    setShowErrors(false);
  };

  // Set during render, React's way to act once on data that arrived. A Zone not in the
  // catalogue is ignored, and so is one picked by hand first.
  if (presetZoneId !== null && catalogueZones.data && versions.data) {
    setPresetZoneId(null);
    const preset = catalogueZones.data.find((zone) => zone.id === presetZoneId);
    if (preset && canAddZone && zoneCode === null && !newZone) chooseZone(preset.code);
  }

  const submit = () => {
    const complete = required.check([
      // A Zone somebody else holds is not a Zone chosen: its slip is shown right there.
      ['zone', pickedCode !== null && !errors.zone && !lockOnSelection],
      ['leader', !errors.leader],
      ['department', !errors.department],
    ]);
    if (!complete || pickedCode === null) {
      setShowErrors(true);
      return;
    }
    addZone.mutate({ zoneCode: pickedCode, zoneName: newZone?.name.trim() || null, draftKey, draft });
  };

  const addZoneCard = canAddZone ? (
    <Card>
      <CardHeader
        title="Select Zone"
        description={
          walkBy
            ? 'Where the walk-by goes, and who leads it. One audit covers one Zone.'
            : 'One audit covers one Zone: its questions, then Submit finishes the audit.'
        }
      />

      <View ref={required.anchor('zone')} collapsable={false}>
      {newZone ? (
        <>
          {/* R-52: the new Zone's number and name, on one line; a subzone letter when ticked. */}
          <ZoneNumberField testID="new-zone-label" label={newZone.label} onChange={(label) => setNewZone({ ...newZone, label })}>
            <Field
              testID="new-zone-name"
              label="Zone name"
              value={newZone.name}
              onChangeText={(value) => setNewZone({ ...newZone, name: value })}
              maxLength={200}
              placeholder="Press shop"
              containerStyle={styles.newZoneName}
            />
          </ZoneNumberField>
          {showErrors && errors.zone ? <Text style={styles.error}>{errors.zone}</Text> : null}
          <Pressable accessibilityRole="button" onPress={() => setNewZone(null)} hitSlop={8}>
            <Text style={styles.link}>Choose one of the Unit’s Zones instead</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Label>Zone</Label>
          <Pressable
            testID="zone-number"
            accessibilityRole="button"
            accessibilityLabel="Choose the Zone"
            onPress={() => setPicking(true)}
            style={[styles.select, showErrors && errors.zone ? styles.selectError : null]}
          >
            <Text style={selected ? styles.selectValue : styles.selectPlaceholder}>
              {selected ? zoneDisplayLabel(selected.code, selected.name) : 'Choose the Zone'}
            </Text>
            <Text style={styles.selectChevron}>▾</Text>
          </Pressable>
          {showErrors && errors.zone ? <Text style={styles.error}>{errors.zone}</Text> : null}
          {mayAddZone ? (
            <Pressable
              testID="new-zone"
              accessibilityRole="button"
              onPress={() => {
                setNewZone({ label: '', name: '' });
                setShowErrors(false);
              }}
              hitSlop={8}
            >
              <Text style={styles.link}>+ New Zone</Text>
            </Pressable>
          ) : null}
        </>
      )}
      </View>

      {/* R-29, said before the questions rather than after them. */}
      {lockOnSelection ? (
        <Slip title="That Zone is taken">
          <SlipText>
            {lockOnSelection.auditorName} is auditing{' '}
            {zoneDisplayLabel(lockOnSelection.zoneCode, lockOnSelection.zoneName)} in another audit of this Unit. Choose a
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
        inputRef={required.input('leader')}
        label="Zone Leader’s name"
        value={draft.leaderName}
        onChangeText={(value) => editDraft({ leaderName: value })}
        placeholder="Full name"
        autoCapitalize="words"
        error={showErrors && errors.leader ? errors.leader : undefined}
      />

      {!walkBy ? (
        <View ref={required.anchor('department')} collapsable={false}>
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
        </View>
      ) : null}

      <ErrorBanner message={addZone.error ? addZone.error.message : null} />

      <Button icon={walkBy ? 'photo-camera' : 'play-arrow'}
        testID="start-zone"
        title={walkBy ? 'Open camera' : 'Start the questions'}
        busy={addZone.isPending}
        onPress={submit}
      />
    </Card>
  ) : null;

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: walkBy ? 'Walk-by' : 'Audit',
          headerRight: () =>
            canRestart ? (
              <HeaderAction icon="restart-alt"
                title={`Restart (${restartsLeft})`}
                accessibilityLabel={`Restart audit, ${restartsLeft} left`}
                disabled={restart.isPending}
                onPress={() => setRestartReason('')}
              />
            ) : canPause || canAbort ? (
              <View style={styles.headerActions}>
                {canPause ? (
                  <HeaderAction icon="pause"
                    title="Save & pause"
                    disabled={leave.isPending || abort.isPending}
                    onPress={() => leave.mutate(null)}
                  />
                ) : null}
                {canAbort ? (
                  <HeaderAction icon="cancel"
                    testID="abort-audit"
                    title="Abort audit"
                    variant="danger"
                    accessibilityLabel="Abort audit. The whole audit is removed."
                    disabled={abort.isPending}
                    onPress={confirmAbort}
                  />
                ) : null}
              </View>
            ) : null,
        }}
      />
      {selfie.sheet}

      <FlatList
        ref={required.scroll}
        data={zonesInAudit}
        keyExtractor={(zone) => zone.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.header}>
            {/* The one slip on this screen: a paused audit is waiting for the auditor. */}
            {paused ? (
              <Slip title="Paused">
                <SlipText>
                  {!cursor.data?.auditZoneId
                    ? 'Everything is saved on this device. Resume to add the next Zone or finish the audit.'
                    : walkBy
                      ? 'Your photographs and remarks are saved on this device.'
                      : `${cursor.data.answered} question${cursor.data.answered === 1 ? '' : 's'} answered in this Zone. Resume where you stopped.`}
                </SlipText>
                <View style={styles.slipAction}>
                  <Button icon="play-arrow" title="Resume" busy={resume.isPending} onPress={() => resume.mutate()} />
                </View>
              </Slip>
            ) : (
              // Otherwise the selfie's, when it has not reached the server: a retake slip if
              // it failed, a line if it is on its way. Also on a finished audit, which cannot
              // finish on the server without it.
              selfie.notice
            )}
            {/*
              The next Zone comes first, above the Zones already done. Below them it sank
              off the bottom of a phone by the sixth Zone, behind the Abort / Save & pause /
              Finish bar, and a Consultant in the field read that as the audit being over:
              they paused it and started a new audit for Zone 7 (2026-09-23).
            */}
            {addZoneCard}
            {canFinish ? (
              <Button icon="send" title="Submit audit" busy={finish.isPending} onPress={confirmFinish} />
            ) : null}
            {zonesInAudit.length > 0 ? (
              <SectionHead
                title="Zones in this audit"
                description={
                  `${finished} of ${liveZones.length} finished` +
                  (zonesInAudit.length > liveZones.length
                    ? ` · ${zonesInAudit.length - liveZones.length} aborted`
                    : '')
                }
              />
            ) : null}
          </View>
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
                <Chip
                  tone={
                    item.status === 'COMPLETED'
                      ? 'ok'
                      : item.status === 'DRAFT' || item.status === 'WITHDRAWN'
                        ? 'muted'
                        : 'warn'
                  }
                >
                  {item.status === 'COMPLETED'
                    ? 'Finished'
                    : item.status === 'WITHDRAWN'
                      ? 'Aborted'
                      : item.status === 'DRAFT'
                        ? 'Not started'
                        : 'In progress'}
                </Chip>
              }
            />
            {item.status === 'WITHDRAWN' ? (
              <Muted>
                Aborted — its answers are cleared from this audit and it is not scored. Start
                the Zone again to audit it afresh.
              </Muted>
            ) : (
              <View style={styles.zoneActions}>
                <View style={styles.zoneAction}>
                  <Button icon={item.status === 'COMPLETED' ? 'visibility' : 'play-arrow'}
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
                {/*
                  R-34: the auditor typed this Zone's description and leader, and until now
                  a typo in either was permanent. Shown only while the audit is open —
                  afterwards the snapshot is what the report renders, and it is history.
                */}
                {auditOpen ? (
                  <View style={styles.zoneAction}>
                    <Button icon="edit"
                      title="Edit details"
                      variant="secondary"
                      onPress={() =>
                        setEditing({
                          auditZoneId: item.id,
                          label: zoneDisplayLabel(item.zoneCodeSnapshot, item.zoneNameSnapshot),
                          description: item.zoneDescriptionSnapshot ?? '',
                          leaderName: item.zoneLeaderNameSnapshot ?? '',
                        })
                      }
                    />
                  </View>
                ) : null}
                {!auditOpen && can('zone', 'update') && item.status === 'COMPLETED' ? (
                  <View style={styles.zoneAction}>
                    <Button icon="drive-file-rename-outline"
                      title="Rename"
                      variant="secondary"
                      onPress={() =>
                        setRenaming({
                          zoneId: item.zoneId,
                          label: zoneDisplayLabel(item.zoneCodeSnapshot, item.zoneNameSnapshot),
                          name: item.zoneNameSnapshot,
                        })
                      }
                    />
                  </View>
                ) : null}
                {/* Abort one Zone without leaving the audit (0031). Unfinished Zones only. */}
                {auditOpen && item.status !== 'COMPLETED' ? (
                  <View style={styles.zoneAction}>
                    <ConfirmAction
                      compact
                      title="Abort Zone"
                      question={`Abort ${zoneDisplayLabel(item.zoneCodeSnapshot, item.zoneNameSnapshot)}? Its answers are cleared from this audit and it leaves the score. The rest of the audit carries on, and you can start this Zone again.`}
                      confirmLabel="Abort this Zone"
                      busy={withdraw.isPending && withdraw.variables === item.id}
                      onConfirm={() => withdraw.mutate(item.id)}
                    />
                  </View>
                ) : null}
              </View>
            )}
          </Card>
        )}
        ListFooterComponent={
          <View style={styles.footer}>
            <Muted>
              Saved on this device. Nothing here waits for a connection, and nothing is lost
              without one.
            </Muted>
          </View>
        }
      />

      <ZoneDetailsPrompt
        edit={editing}
        busy={editZone.isPending}
        error={editZone.error ? editZone.error.message : null}
        onChange={setEditing}
        onCancel={() => setEditing(null)}
        onSave={() => editing && editZone.mutate(editing)}
      />

      <RenamePrompt
        rename={renaming}
        busy={rename.isPending}
        error={problemMessage(rename.error) ?? (rename.error ? rename.error.message : null)}
        onChange={(name) => renaming && setRenaming({ ...renaming, name })}
        onCancel={() => {
          setRenaming(null);
          rename.reset();
        }}
        onSave={() => renaming && renaming.name.trim() && rename.mutate(renaming)}
      />

      <RestartPrompt
        visible={restartReason !== null}
        reason={restartReason ?? ''}
        remaining={restartsLeft}
        busy={restart.isPending}
        error={restart.error ? restart.error.message : null}
        onChange={setRestartReason}
        onCancel={() => setRestartReason(null)}
        onConfirm={() => restart.mutate(restartReason ?? '')}
      />

      <ZonePicker
        visible={picking}
        zones={catalogueZones.data ?? []}
        usedCodes={usedCodes}
        lockedByCode={lockedByCode}
        mayAddZone={mayAddZone}
        onPick={chooseZone}
        onClose={() => setPicking(false)}
      />
    </Screen>
  );
}

/**
 * R-34: correcting the Zone details the auditor typed.
 *
 * The same two fields the Zone was created with, in the same order, because this is the
 * same act — an auditor saying what this Zone is and who leads it. It reads as a
 * correction rather than a new form for exactly that reason.
 *
 * The Zone *number* is not here. Changing it re-points the audit at a different Zone,
 * which R-29's claim and the one-Zone-per-audit rule both govern; the server decides that,
 * and a phone offering it in a details sheet would be promising something it cannot check
 * offline.
 */
function ZoneDetailsPrompt({
  edit,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  edit: ZoneEdit | null;
  busy: boolean;
  error: string | null;
  onChange: (next: ZoneEdit) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const styles = useStyles();
  const inset = useSheetInset();

  return (
    <Modal
      visible={edit !== null}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <Pressable style={styles.scrim} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, inset]}>
        <Text style={styles.sheetTitle} accessibilityRole="header">
          {edit ? edit.label : 'Zone details'}
        </Text>
        {edit ? (
          <View style={styles.restartBody}>
            <Field
              label="Description"
              value={edit.description}
              onChangeText={(value) => onChange({ ...edit, description: value })}
              multiline
              placeholder="What this Zone covers"
            />
            <Field
              label="Zone Leader"
              value={edit.leaderName}
              onChangeText={(value) => onChange({ ...edit, leaderName: value })}
              placeholder="The name to print on the report"
            />
            <ErrorBanner message={error} />
            <Button icon="save" title="Save details" busy={busy} onPress={onSave} />
            <Button icon="close" title="Cancel" variant="secondary" onPress={onCancel} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/** Renaming a done audit's Zone: one field, the name as it should read everywhere. */
function RenamePrompt({
  rename,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  rename: { label: string; name: string } | null;
  busy: boolean;
  error: string | null;
  onChange: (name: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const styles = useStyles();
  const inset = useSheetInset();

  return (
    <Modal visible={rename !== null} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, inset]}>
        <Text style={styles.sheetTitle} accessibilityRole="header">
          Rename {rename?.label ?? 'Zone'}
        </Text>
        {rename ? (
          <View style={styles.restartBody}>
            <Field
              label="Zone name"
              value={rename.name}
              onChangeText={onChange}
              placeholder="e.g. Press shop"
              autoCapitalize="words"
              hint="Changes the name on this audit, its other audits and any report regenerated."
            />
            <ErrorBanner message={error} />
            <Button icon="save" title="Save name" busy={busy} disabled={!rename.name.trim()} onPress={onSave} />
            <Button icon="close" title="Cancel" variant="secondary" onPress={onCancel} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/**
 * R-33's restart, and the reason it asks for one.
 *
 * A justification is not friction for its own sake: a restart is a change to a finished
 * audit, and A-2's rule is that those happen only where the change is recorded with why.
 * The same ten-character floor the correction door uses, so the two ways of changing a
 * finished audit ask the same thing of whoever walks through.
 *
 * The count is on the face of it rather than behind the tap. An auditor deciding whether
 * to spend a chance should be able to see how many are left while they decide.
 */
function RestartPrompt({
  visible,
  reason,
  remaining,
  busy,
  error,
  onChange,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  reason: string;
  remaining: number;
  busy: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const styles = useStyles();
  const inset = useSheetInset();
  const tooShort = reason.trim().length < MIN_RESTART_REASON;
  const required = useRequiredFields<'reason'>();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, inset]}>
        <Text style={styles.sheetTitle} accessibilityRole="header">
          Restart this audit?
        </Text>
        <View style={styles.restartBody}>
          <Muted>
            {remaining === MAX_AUDIT_RESTARTS
              ? `An audit can be restarted ${MAX_AUDIT_RESTARTS} times. This would be the first.`
              : `${remaining} restart${remaining === 1 ? '' : 's'} left on this audit.`}
          </Muted>
          <Muted>
            It goes back to in progress so you can correct it, and anything it raised for a
            Zone leader stops until you finish it again.
          </Muted>
          <Field
            label="Why are you restarting it?"
            inputRef={required.input('reason')}
            error={required.error(
              'reason',
              `A few more words — at least ${MIN_RESTART_REASON} characters.`,
              !tooShort,
            )}
            value={reason}
            onChangeText={onChange}
            multiline
            placeholder="Finished before auditing the packing bay"
          />
          <ErrorBanner message={error} />
          <Button icon="restart-alt"
            title="Restart audit"
            busy={busy}
            onPress={() => required.check([['reason', !tooShort]]) && onConfirm()}
          />
          <Button icon="check" title="Leave it finished" variant="secondary" onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}

/**
 * The Unit's Zones as a dropdown: a ruled sheet from the bottom edge, within thumb reach.
 *
 * Two kinds of Zone cannot be chosen, and the row says which it is rather than only going
 * grey. One is already in this audit (§5.5). The other is in somebody else's open audit of
 * this Unit (R-29) — that row names the auditor holding it, because "taken" with no name
 * is the kind of refusal that ends in a phone call to the office.
 */
function ZonePicker({
  visible,
  zones,
  usedCodes,
  lockedByCode,
  mayAddZone,
  onPick,
  onClose,
}: {
  visible: boolean;
  zones: readonly CatalogueZone[];
  usedCodes: ReadonlySet<string>;
  lockedByCode: ReadonlyMap<string, ZoneLock>;
  mayAddZone: boolean;
  onPick: (zoneCode: string) => void;
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
          data={zones}
          keyExtractor={(zone) => zone.id}
          style={styles.sheetList}
          initialNumToRender={20}
          ListEmptyComponent={
            <Muted>
              {mayAddZone
                ? 'This Unit has no Zones yet. Close this and tap + New Zone.'
                : 'This Unit has no Zones yet. Ask its Coordinator to add them, then pull down on Units to refresh.'}
            </Muted>
          }
          renderItem={({ item }) => {
            const inThisAudit = usedCodes.has(item.code);
            const lock = lockedByCode.get(item.code);
            const taken = inThisAudit || lock !== undefined;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: taken }}
                disabled={taken}
                onPress={() => {
                  onClose();
                  onPick(item.code);
                }}
                style={({ pressed }) => [styles.sheetRow, taken && styles.sheetRowTaken, pressed && styles.pressed]}
              >
                <Text style={[styles.sheetLabel, taken && styles.sheetLabelTaken]}>
                  {zoneDisplayLabel(item.code, item.name)}
                </Text>
                {inThisAudit ? (
                  <Text style={styles.sheetDetail}>Already in this audit</Text>
                ) : lock ? (
                  <Text style={styles.sheetDetail}>Being audited by {lock.auditorName}</Text>
                ) : item.zoneLeaderName ? (
                  <Text style={styles.sheetDetail}>Leader {item.zoneLeaderName}</Text>
                ) : null}
              </Pressable>
            );
          }}
        />
        <Button icon="close" title="Cancel" variant="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

const useStyles = createThemedStyles((theme) => ({
  headerActions: { flexDirection: 'row', gap: theme.space.sm },
  centered: { alignItems: 'center', justifyContent: 'center' },
  restartBody: { gap: theme.space.sm, paddingTop: theme.space.xs },
  zoneActions: { flexDirection: 'row', gap: theme.space.sm, marginTop: theme.space.sm },
  zoneAction: { flex: 1 },
  header: { gap: theme.space.sm },
  footer: { gap: theme.space.sm, marginTop: theme.space.lg, paddingBottom: theme.space.md },
  slipAction: { marginTop: theme.space.xs },
  gapAbove: { marginTop: theme.space.md },
  newZoneName: { flex: 1 },
  link: {
    fontFamily: theme.family.medium,
    fontSize: theme.font.base,
    color: theme.color.ink,
    textDecorationLine: 'underline',
    marginTop: theme.space.sm,
  },
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
