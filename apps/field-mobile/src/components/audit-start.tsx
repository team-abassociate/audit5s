import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter, type Href } from 'expo-router';
import { HeaderBackButton } from 'expo-router/react-navigation';
import type { AuditType } from '@audit5s/contracts';
import { ActionSheet, EmptyState, ErrorBanner, Screen, SelectField } from './ui';
import { CameraCapture } from './camera-capture';
import {
  createLocalAudit,
  discardLocalAuditIfEmpty,
  listResumableAudits,
  resumeLocalAudit,
} from '../lib/db/audit.repository';
import { listLocalUnits } from '../lib/db/catalogue.repository';
import { syncCatalogue } from '../lib/catalogue';
import { captureLocalEvidence } from '../lib/db/evidence.repository';
import { useLocalDatabase } from '../lib/db/provider';
import type { ProcessedImage } from '../lib/capture/media';
import { useSession } from '../lib/session';
import { createThemedStyles, useTheme } from '../lib/theme';
import { leaveScreen } from '../lib/leave-screen';

const AUDIT_TYPE_LABELS: Record<AuditType, string> = {
  EXTERNAL_5S: '5S audit',
  WALK_BY: 'Walk-by',
  CROSS_5S: 'Cross audit',
};

/**
 * What the signed-in person may start here (PART 6), read from their grants as the web does.
 * A Coordinator starts a 5S audit only (owner, 2026-10-12), though they hold all three.
 */
function auditTypesFor(can: (resource: string, action: string) => boolean, coordinator: boolean): AuditType[] {
  if (coordinator) return ['EXTERNAL_5S'];
  const types: AuditType[] = [];
  if (can('audit', 'create_external')) types.push('EXTERNAL_5S');
  if (can('audit', 'create_walk_by')) types.push('WALK_BY');
  if (can('audit', 'create_cross')) types.push('CROSS_5S');
  return types;
}

/**
 * The way into an audit: the selfie, then the Zones (R-19, §7.1), and nothing in between
 * (owner, 2026-10-12). There is no start screen. What has to be asked is asked over a blank
 * screen and only when there is a real choice:
 *
 * - the Unit, as a dropdown, when the route did not name one and the device holds several;
 * - an audit this phone already has open in the Unit — carry on with it, or start another
 *   (2026-09-23: without it a Consultant who backed out could only start a second audit);
 * - the kind, when the person may run more than one (a Consultant's 5S audit or Walk-by).
 *
 * Then the camera. The audit row is written only once the selfie is in SQLite, so backing
 * out of the camera leaves no empty audit behind. Starting one writes locally and nothing
 * else: the server hears about it when the outbox drains and arbitrates ownership then (D7).
 *
 * Routes: `/unit/[unitId]`, pushed from a Units list or a Unit's page; `/audit/start`, the +
 * menu's "Start one myself", with no `unitId`; and a tab (`tab`), which is not pushed, so the
 * way on to the Zones is a push rather than a replace — replacing would swap out the tab bar.
 */
export function AuditStart({
  unitId: fixedUnitId,
  tab = false,
  type: presetType,
  zoneId: presetZoneId,
}: {
  unitId?: string;
  tab?: boolean;
  /** Preselected kind, e.g. the Overview's cross-audit call; ignored unless they may start it. */
  type?: string;
  /** The Zone a cross-audit call names: chosen on the Zones step after the selfie. */
  zoneId?: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const leaveTo = (href: Href) => (tab ? router.push(href) : router.replace(href));
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/overview'));
  const { can, scope } = useSession();

  /*
   * The offline catalogue — this Unit, its Zones, the departments — pulled on the way in,
   * as the Units tab does. A Coordinator or Super Admin reaches this from the management
   * Overview, which never pulls it, and their Zone step was left with no Zones and no
   * departments (R-52). The same key as the Units tab, so it runs once either way.
   */
  useQuery({
    queryKey: ['catalogue', 'bootstrap'],
    queryFn: async () => {
      await syncCatalogue(database)
        .then(() => queryClient.invalidateQueries({ queryKey: ['local'] }))
        .catch(() => undefined);
      return true;
    },
    staleTime: 60_000,
  });

  const units = useQuery({
    queryKey: ['local', 'units'],
    queryFn: () => listLocalUnits(database),
    enabled: !fixedUnitId,
  });
  const [pickedUnitId, setPickedUnitId] = useState<string | null>(null);
  // A Coordinator or Zone Leader holds one Unit, and so does a device with one Unit on it:
  // that is the pick already made, and they never see the dropdown.
  const ownUnitId = scope && !scope.organizationWide && scope.unitIds.length === 1 ? scope.unitIds[0]! : null;
  const onlyUnitId = units.data?.length === 1 ? units.data[0]!.id : null;
  const unitId = fixedUnitId ?? pickedUnitId ?? ownUnitId ?? onlyUnitId;

  const openHere = useQuery({
    queryKey: ['local', 'resumable-audits'],
    queryFn: () => listResumableAudits(database),
    // One with no Zone yet is a selfie someone backed out of: nothing to carry on with.
    select: (audits) => audits.find((audit) => audit.unitId === unitId && audit.zonesTotal > 0) ?? null,
    enabled: unitId !== null,
  });
  const existing = openHere.data ?? null;

  const types = auditTypesFor(can, scope?.role === 'COORDINATOR');
  const [pickedType, setPickedType] = useState<AuditType | null>(null);
  const preset = types.find((type) => type === presetType) ?? null;
  const auditType = types.length === 1 ? types[0]! : (pickedType ?? preset);

  // `null` until they answer the open-audit question; 'new' once they choose another audit.
  const [openChoice, setOpenChoice] = useState<'continue' | 'new' | null>(null);
  // A sheet closed without a choice means "not now": go back to where they came from.
  // ActionSheet calls onClose before the action, in one batch, so the effects see both.
  const [openSheetClosed, setOpenSheetClosed] = useState(false);
  const [kindSheetClosed, setKindSheetClosed] = useState(false);
  useEffect(() => {
    if (openSheetClosed && openChoice === null) leave();
  }, [openSheetClosed, openChoice]);
  useEffect(() => {
    if (kindSheetClosed && auditType === null) leave();
  }, [kindSheetClosed, auditType]);

  const continueAudit = useMutation({
    mutationFn: async (auditId: string) => {
      if (existing?.status === 'PAUSED') await resumeLocalAudit(database, auditId);
      return auditId;
    },
    onSuccess: (auditId) =>
      leaveScreen(
        () => leaveTo({ pathname: '/audit/zones/[auditId]', params: { auditId } }),
        () => void queryClient.invalidateQueries({ queryKey: ['local'] }),
      ),
  });

  // A selfie that failed to save is retaken into the same audit, not a second one.
  const madeAuditId = useRef<string | null>(null);
  const saveSelfie = useMutation({
    mutationFn: async (image: ProcessedImage) => {
      // No audit-level checklist: the department is chosen per Zone, and that is the
      // version each Zone pins (QR-2). The row comes before the evidence: `evidence.audit_id`
      // is a foreign key on the server and the device mirrors its shape.
      // And those backed-out selfies go now (before 2026-10-14, Back left them open).
      if (!madeAuditId.current) {
        const open = await listResumableAudits(database);
        for (const audit of open) if (audit.zonesTotal === 0) await discardLocalAuditIfEmpty(database, audit.id);
      }
      const auditId =
        madeAuditId.current ??
        (await createLocalAudit(database, { unitId: unitId!, auditType: auditType!, checklistVersionId: null }));
      madeAuditId.current = auditId;
      await captureLocalEvidence(database, {
        auditId,
        kind: 'AUDITOR_SELFIE',
        localFileUri: image.uri,
        byteSize: image.byteSize,
        width: image.width,
        height: image.height,
        checksumSha256: image.checksumSha256,
      });
      return auditId;
    },
    onSuccess: (auditId) =>
      leaveScreen(
        // Replace, so Back from the Zone form does not land on a spent selfie screen.
        () =>
          leaveTo({
            pathname: '/audit/zones/[auditId]',
            params: presetZoneId ? { auditId, zoneId: presetZoneId } : { auditId },
          }),
        () => void queryClient.invalidateQueries({ queryKey: ['local'] }),
      ),
  });

  const header = (title = 'Start an audit') => (
    <Stack.Screen
      options={{
        ...(tab ? {} : { title }),
        headerLeft: ({ tintColor }) => <HeaderBackButton tintColor={tintColor} onPress={leave} />,
      }}
    />
  );

  // No Unit yet: the dropdown, and nothing else on the screen.
  if (unitId === null) {
    const none = units.isSuccess && units.data.length === 0;
    return (
      <Screen>
        {header('Choose the Unit')}
        {units.isPending ? (
          <ActivityIndicator color={theme.color.ink} />
        ) : none ? (
          <EmptyState title="No Unit" detail="No Unit is on this phone yet. Connect to the internet once to load your Unit." />
        ) : (
          <View style={styles.content}>
            <SelectField
              label="Unit"
              placeholder="Choose the Unit"
              searchable
              value={null}
              onChange={setPickedUnitId}
              options={(units.data ?? []).map((option) => ({ value: option.id, label: option.name }))}
            />
          </View>
        )}
      </Screen>
    );
  }

  if (!openHere.isSuccess) return <Screen>{header()}</Screen>;

  if (existing && openChoice !== 'new') {
    const paused = existing.status === 'PAUSED';
    return (
      <Screen>
        {header()}
        <ErrorBanner message={continueAudit.error ? 'The audit could not be opened. Try again.' : null} />
        <ActionSheet
          visible={openChoice === null && !openSheetClosed}
          title={paused ? 'Your audit here is paused' : 'Your audit here is not submitted yet'}
          onClose={() => setOpenSheetClosed(true)}
          actions={[
            {
              label: paused ? 'Resume it' : 'Carry on with it',
              onPress: () => {
                setOpenChoice('continue');
                continueAudit.mutate(existing.id);
              },
            },
            {
              label: 'Start a new audit',
              detail: 'For a different Zone. The open one stays open to finish later.',
              onPress: () => setOpenChoice('new'),
            },
          ]}
        />
      </Screen>
    );
  }

  if (auditType === null) {
    return (
      <Screen>
        {header()}
        <ActionSheet
          visible={!kindSheetClosed}
          title="Which audit?"
          onClose={() => setKindSheetClosed(true)}
          actions={types.map((type) => ({ label: AUDIT_TYPE_LABELS[type], onPress: () => setPickedType(type) }))}
        />
      </Screen>
    );
  }

  return (
    <>
      {header('Your selfie')}
      <CameraCapture
        facing="front"
        prompt={`Take your selfie to begin the ${auditType === 'WALK_BY' ? 'walk-by' : 'audit'}`}
        onCaptured={async (image) => {
          await saveSelfie.mutateAsync(image);
        }}
        onCancel={leave}
      />
    </>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { gap: theme.space.sm, paddingTop: theme.space.sm },
}));
