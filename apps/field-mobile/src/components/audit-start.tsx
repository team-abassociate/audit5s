import { useEffect, useState } from 'react';
import { Alert, BackHandler, ScrollView, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter, type Href } from 'expo-router';
import { HeaderBackButton } from 'expo-router/react-navigation';
import type { AuditType } from '@audit5s/contracts';
import {
  ActionBar,
  Button,
  Card,
  CardHeader,
  ErrorBanner,
  HeaderTitle,
  Muted,
  Screen,
  SectionHead,
  Segmented,
  Slip,
  SelectField,
  SlipText,
} from './ui';
import { CameraCapture } from './camera-capture';
import {
  createLocalAudit,
  listResumableAudits,
  resumeLocalAudit,
} from '../lib/db/audit.repository';
import { getLocalUnit, listLocalUnits } from '../lib/db/catalogue.repository';
import { syncCatalogue } from '../lib/catalogue';
import { captureLocalEvidence } from '../lib/db/evidence.repository';
import { useLocalDatabase } from '../lib/db/provider';
import type { ProcessedImage } from '../lib/capture/media';
import { useSession } from '../lib/session';
import { createThemedStyles } from '../lib/theme';
import { leaveScreen } from '../lib/leave-screen';

const AUDIT_TYPE_LABELS: Record<AuditType, string> = {
  EXTERNAL_5S: '5S audit',
  WALK_BY: 'Walk-by',
  CROSS_5S: 'Cross audit',
};

/** What the signed-in person may start here (PART 6), read from their grants as the web does. */
function auditTypesFor(can: (resource: string, action: string) => boolean): AuditType[] {
  const types: AuditType[] = [];
  if (can('audit', 'create_external')) types.push('EXTERNAL_5S');
  if (can('audit', 'create_walk_by')) types.push('WALK_BY');
  if (can('audit', 'create_cross')) types.push('CROSS_5S');
  return types;
}

/**
 * Opening a Unit is the way into an audit, and the selfie comes first (R-19, §7.1).
 *
 * Starting one writes a row locally and nothing else: no request is made, and none is
 * waited for. The server hears about the audit when the outbox drains, and arbitrates
 * device ownership then (D7). The Zone is chosen on the next screen, after the selfie —
 * one of the Unit's Zones, its description, the leader's name and the department.
 *
 * Three routes show it: `/unit/[unitId]`, pushed from a Units list; `/audit/start`, the + menu's
 * "Start one myself", which picks the Unit from a dropdown right here (no `unitId`) rather than
 * sending the Super Admin through the Units tab; and a Zone Leader's Audit tab (`tab`), which
 * holds their one Unit. A tab is not pushed, so the way on to the Zones is
 * a push rather than a replace — replacing would swap out the whole tab bar, and Back from
 * the Zones would leave the app.
 */
export function AuditStart({ unitId: fixedUnitId, tab = false }: { unitId?: string; tab?: boolean }) {
  const styles = useStyles();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const leaveTo = (href: Href) => (tab ? router.push(href) : router.replace(href));
  const { can } = useSession();

  /*
   * The offline catalogue — this Unit, its Zones, the departments — pulled on the way in,
   * as the Units tab does. A Coordinator or Super Admin reaches this screen from the
   * management Overview, which never pulls it, and their Zone step was left with no Zones
   * and no departments (R-52). The same key as the Units tab, so it runs once either way.
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
  const [unitMissing, setUnitMissing] = useState(false);
  // One Unit on the device is the pick already made.
  const onlyUnitId = units.data?.length === 1 ? units.data[0]!.id : null;
  const unitId = fixedUnitId ?? pickedUnitId ?? onlyUnitId;

  const unit = useQuery({
    queryKey: ['local', 'unit', unitId],
    queryFn: () => getLocalUnit(database, unitId!),
    enabled: unitId !== null,
  });

  /*
   * An audit this phone already has open in this Unit. Opening the Unit used to offer only
   * "Start an audit", so a Consultant who had left their audit — paused, or simply backed
   * out to the Units list — could only come back in by starting a second one, and the
   * day's Zones were split across audits (2026-09-23). The open one is offered first now.
   */
  const openHere = useQuery({
    queryKey: ['local', 'resumable-audits'],
    queryFn: () => listResumableAudits(database),
    select: (audits) => audits.find((audit) => audit.unitId === unitId) ?? null,
  });
  const existing = openHere.data ?? null;

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

  const types = auditTypesFor(can);
  const [picked, setPicked] = useState<AuditType | null>(null);
  const auditType = picked ?? types[0] ?? null;
  const walkBy = auditType === 'WALK_BY';

  // §7.1's selfie gate, on the device. The audit row is created first — `evidence.audit_id`
  // is a foreign key on the server and the device mirrors its shape — then the camera
  // opens, and the audit is only usable once the selfie is in SQLite.
  const [pendingAuditId, setPendingAuditId] = useState<string | null>(null);

  // Back over the selfie camera closes the camera and returns to this Unit.
  useEffect(() => {
    if (!pendingAuditId) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setPendingAuditId(null);
      return true;
    });
    return () => subscription.remove();
  }, [pendingAuditId]);

  const startAudit = useMutation({
    mutationFn: (type: AuditType) =>
      // No audit-level checklist: the department is chosen per Zone, and that is the
      // version each Zone pins (QR-2).
      createLocalAudit(database, { unitId: unitId!, auditType: type, checklistVersionId: null }),
    onSuccess: async (auditId) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      setPendingAuditId(auditId);
    },
  });

  const saveSelfie = useMutation({
    mutationFn: async (image: ProcessedImage) => {
      const auditId = pendingAuditId!;
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
    onSuccess: (auditId) => {
      setPendingAuditId(null);
      leaveScreen(
        // Replace, so Back from the Zone form does not land on a spent selfie screen.
        () => leaveTo({ pathname: '/audit/zones/[auditId]', params: { auditId } }),
        () => void queryClient.invalidateQueries({ queryKey: ['local'] }),
      );
    },
  });

  if (pendingAuditId) {
    return (
      <>
      <Stack.Screen
        options={{
          headerLeft: ({ tintColor }) => (
            <HeaderBackButton tintColor={tintColor} onPress={() => setPendingAuditId(null)} />
          ),
        }}
      />
      <CameraCapture
        facing="front"
        prompt={`Take your selfie to begin the ${walkBy ? 'walk-by' : 'audit'}`}
        onCaptured={async (image) => {
          await saveSelfie.mutateAsync(image);
        }}
        onCancel={() => {
          // The audit row stays: it is at ASSIGNED with no selfie, which is exactly what
          // §7.1 describes, and the auditor can come back to it from Audits.
          setPendingAuditId(null);
        }}
      />
      </>
    );
  }

  const title = fixedUnitId ? (unit.data?.[0]?.name ?? 'Unit') : 'Start an audit';
  const start = (type: AuditType) => {
    if (!unitId) {
      setUnitMissing(true);
      return;
    }
    startAudit.mutate(type);
  };

  return (
    <Screen>
      {/* In a tab, `title` would rename the tab itself; the header names the Unit, the bar says Audit. */}
      <Stack.Screen
        options={
          tab
            ? { headerTitle: () => <HeaderTitle>{title}</HeaderTitle>, headerLeft: undefined }
            : { title, headerBackTitle: fixedUnitId ? 'Units' : undefined, headerLeft: undefined }
        }
      />

      <ScrollView contentContainerStyle={styles.content}>
        {fixedUnitId ? null : (
          <View>
            <SelectField
              label="Unit"
              placeholder={units.isLoading ? 'Loading Units…' : 'Choose the Unit'}
              value={unitId}
              onChange={(next) => {
                setPickedUnitId(next);
                setUnitMissing(false);
              }}
              options={(units.data ?? []).map((option) => ({ value: option.id, label: option.name }))}
            />
            <ErrorBanner message={unitMissing ? 'Choose the Unit first.' : null} />
          </View>
        )}

        {existing ? (
          <Slip title="Your audit here is still open">
            <SlipText>
              {existing.status === 'PAUSED' ? 'It is paused' : 'It is not submitted yet'}. Carry on
              with it, or start a separate audit for a different Zone.
            </SlipText>
            <View style={styles.slipAction}>
              <Button
                testID="continue-audit"
                title={existing.status === 'PAUSED' ? 'Resume this audit' : 'Continue this audit'}
                busy={continueAudit.isPending}
                onPress={() => continueAudit.mutate(existing.id)}
              />
            </View>
          </Slip>
        ) : null}

        <SectionHead
          title={existing ? 'Or start a separate audit' : 'Start an audit'}
          description="Your selfie first, then the Zone. Nothing here needs a connection."
        />

        {types.length > 1 && auditType ? (
          <Segmented
            options={types.map((value) => ({ value, label: AUDIT_TYPE_LABELS[value] }))}
            value={auditType}
            onChange={setPicked}
          />
        ) : null}

        <Card>
          <CardHeader
            title="1 · Take your selfie"
            description="A live photograph at the Unit. It starts the audit."
          />
        </Card>
        <Card>
          <CardHeader
            title="2 · Select the Zone"
            description={
              walkBy
                ? 'One of the Unit’s Zones, an optional description and the Zone Leader’s name. Then the photographs.'
                : 'One of the Unit’s Zones, an optional description, the Zone Leader’s name and the department. Then its 50 questions — Submit finishes the audit.'
            }
          />
        </Card>

        <ErrorBanner
          message={
            startAudit.error || saveSelfie.error
              ? 'The audit could not be started on this device. Try again.'
              : null
          }
        />
      </ScrollView>

      {auditType ? (
        <ActionBar>
          <Button
            testID="start-audit"
            title="Take selfie"
            busy={startAudit.isPending}
            variant={existing ? 'secondary' : 'primary'}
            onPress={() =>
              existing
                ? Alert.alert(
                    'Start a separate audit?',
                    'Your open audit of this Unit stays open to finish later. An audit covers ' +
                      'one Zone, so the new one is for a different Zone.',
                    [
                      { text: 'Keep my audit', style: 'cancel' },
                      { text: 'Start new audit', onPress: () => start(auditType) },
                    ],
                  )
                : start(auditType)
            }
          />
          <Muted>Work is saved on this device and syncs when there is a connection.</Muted>
        </ActionBar>
      ) : null}
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { gap: theme.space.sm, paddingBottom: theme.space.md },
  slipAction: { marginTop: theme.space.xs },
}));
