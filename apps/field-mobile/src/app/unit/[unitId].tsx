import { useState } from 'react';
import { ScrollView } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { AuditType } from '@audit5s/contracts';
import {
  ActionBar,
  Button,
  Card,
  CardHeader,
  ErrorBanner,
  Muted,
  Screen,
  SectionHead,
  Segmented,
} from '../../components/ui';
import { CameraCapture } from '../../components/camera-capture';
import { createLocalAudit, recordAuditStartLocation } from '../../lib/db/audit.repository';
import { getLocalUnit } from '../../lib/db/catalogue.repository';
import { captureLocalEvidence } from '../../lib/db/evidence.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { readLocation } from '../../lib/capture/location';
import type { ProcessedImage } from '../../lib/capture/media';
import { useSession } from '../../lib/session';
import { createThemedStyles } from '../../lib/theme';
import { leaveScreen } from '../../lib/leave-screen';

const AUDIT_TYPE_LABELS: Record<AuditType, string> = {
  EXTERNAL_5S: '5S audit',
  WALK_BY: 'Walk-by',
  CROSS_5S: 'Cross audit',
};

/** What each role may start here (PART 6). R-18: a Super Admin may start every type. */
function auditTypesFor(role: string | undefined): AuditType[] {
  if (role === 'CONSULTANT') return ['EXTERNAL_5S', 'WALK_BY'];
  if (role === 'ZONE_LEADER') return ['CROSS_5S'];
  if (role === 'SUPER_ADMIN') return ['EXTERNAL_5S', 'WALK_BY', 'CROSS_5S'];
  return [];
}

/**
 * Opening a Unit is the way into an audit, and the selfie comes first (R-19, §7.1).
 *
 * Starting one writes a row locally and nothing else: no request is made, and none is
 * waited for. The server hears about the audit when the outbox drains, and arbitrates
 * device ownership then (D7). The Zone is created on the next screen, after the selfie —
 * the Zone number, its description, the leader's name and the department.
 */
export default function UnitStartScreen() {
  const styles = useStyles();
  const { unitId } = useLocalSearchParams<{ unitId: string }>();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { scope } = useSession();

  const unit = useQuery({
    queryKey: ['local', 'unit', unitId],
    queryFn: () => getLocalUnit(database, unitId),
  });

  const types = auditTypesFor(scope?.role);
  const [picked, setPicked] = useState<AuditType | null>(null);
  const auditType = picked ?? types[0] ?? null;
  const walkBy = auditType === 'WALK_BY';

  // §7.1's selfie gate, on the device. The audit row is created first — `evidence.audit_id`
  // is a foreign key on the server and the device mirrors its shape — then the camera
  // opens, and the audit is only usable once the selfie is in SQLite.
  const [pendingAuditId, setPendingAuditId] = useState<string | null>(null);

  const startAudit = useMutation({
    mutationFn: (type: AuditType) =>
      // No audit-level checklist: the department is chosen per Zone, and that is the
      // version each Zone pins (QR-2).
      createLocalAudit(database, { unitId, auditType: type, checklistVersionId: null }),
    onSuccess: async (auditId) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      setPendingAuditId(auditId);
    },
  });

  const saveSelfie = useMutation({
    mutationFn: async (image: ProcessedImage) => {
      const auditId = pendingAuditId!;
      // The location reading rides with the selfie. It never waits for a fix: the camera
      // warmed one up while the auditor framed the shot, `readLocation` takes whatever is
      // ready, and §12.9 requires an absent fix be recorded and flagged, never a failure.
      const location = await readLocation();

      await captureLocalEvidence(database, {
        auditId,
        kind: 'AUDITOR_SELFIE',
        localFileUri: image.uri,
        byteSize: image.byteSize,
        width: image.width,
        height: image.height,
        checksumSha256: image.checksumSha256,
        ...(location
          ? {
              location: {
                latitude: location.latitude,
                longitude: location.longitude,
                accuracyM: location.accuracyM ?? null,
                provider: location.provider,
              },
            }
          : {}),
      });

      await recordAuditStartLocation(database, auditId, location);
      return auditId;
    },
    onSuccess: (auditId) => {
      setPendingAuditId(null);
      leaveScreen(
        // Replace, so Back from the Zone form does not land on a spent selfie screen.
        () => router.replace({ pathname: '/audit/zones/[auditId]', params: { auditId } }),
        () => void queryClient.invalidateQueries({ queryKey: ['local'] }),
      );
    },
  });

  if (pendingAuditId) {
    return (
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
    );
  }

  const title = unit.data?.[0]?.name ?? 'Unit';

  return (
    <Screen>
      <Stack.Screen options={{ title, headerBackTitle: 'Units' }} />

      <ScrollView contentContainerStyle={styles.content}>
        <SectionHead
          title="Start an audit"
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
            description="A live photograph at the Unit. It starts the audit and records where you are."
          />
        </Card>
        <Card>
          <CardHeader
            title="2 · Create the Zone"
            description={
              walkBy
                ? 'Zone 1 to 100, an optional description and the Zone Leader’s name. Then the photographs.'
                : 'Zone 1 to 100, an optional description, the Zone Leader’s name and the department. Then its 50 questions.'
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
            onPress={() => startAudit.mutate(auditType)}
          />
          <Muted>Work is saved on this device and syncs when there is a connection.</Muted>
        </ActionBar>
      ) : null}
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { gap: theme.space.sm, paddingBottom: theme.space.md },
}));
