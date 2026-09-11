import { useState } from 'react';
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
import { CameraCapture } from '../../components/camera-capture';
import { captureLocalEvidence } from '../../lib/db/evidence.repository';
import { recordAuditStartLocation } from '../../lib/db/audit.repository';
import { readLocation } from '../../lib/capture/location';
import type { ProcessedImage } from '../../lib/capture/media';
import { useSession } from '../../lib/session';
import { theme } from '../../lib/theme';
import type { AuditType } from '@audit5s/contracts';

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

  // §7.1's selfie gate, on the device. The audit row is created first — `evidence.audit_id`
  // is a foreign key on the server and the device mirrors its shape — then the camera
  // opens, and the audit is only usable once the selfie is in SQLite.
  const [capturing, setCapturing] = useState(false);
  const [pendingAuditId, setPendingAuditId] = useState<string | null>(null);
  const [pendingAuditType, setPendingAuditType] = useState<AuditType | null>(null);

  const startAudit = useMutation({
    mutationFn: (auditType: AuditType) =>
      createLocalAudit(database, {
        unitId,
        auditType,
        // The first published version on the device. Phase 4 lets the auditor pick the
        // department when a Unit uses more than one.
        checklistVersionId: auditType === 'WALK_BY' ? null : (versions.data?.[0]?.id ?? null),
      }),
    onSuccess: async (auditId, auditType) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      setPendingAuditId(auditId);
      setPendingAuditType(auditType);
      setCapturing(true);
    },
  });

  const saveSelfie = useMutation({
    mutationFn: async (image: ProcessedImage) => {
      const auditId = pendingAuditId!;
      // The location reading rides with the selfie. It never blocks: `readLocation`
      // returns null on a denied permission or a timeout, and §12.9 requires that an
      // absent fix be recorded and flagged rather than treated as a failure.
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
    onSuccess: async (auditId) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      setCapturing(false);
      setPendingAuditId(null);
      setPendingAuditType(null);
      router.push({ pathname: '/audit/zones/[auditId]', params: { auditId } });
    },
  });

  if (capturing && pendingAuditId) {
    return (
      <CameraCapture
        facing="front"
        prompt={`Take your photograph to begin the ${pendingAuditType === 'WALK_BY' ? 'walk-by' : 'audit'}`}
        onCaptured={async (image) => {
          await saveSelfie.mutateAsync(image);
        }}
        onCancel={() => {
          // The audit row stays: it is at ASSIGNED with no selfie, which is exactly what
          // §7.1 describes, and the auditor can come back to it from History.
          setCapturing(false);
          setPendingAuditId(null);
          setPendingAuditType(null);
        }}
      />
    );
  }

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
                title={scope?.role === 'ZONE_LEADER' ? 'Start cross audit' : 'Start 5S audit'}
                busy={startAudit.isPending}
                onPress={() =>
                  startAudit.mutate(scope?.role === 'ZONE_LEADER' ? 'CROSS_5S' : 'EXTERNAL_5S')
                }
              />
              {scope?.role === 'CONSULTANT' ? (
                <Button
                  title="Start walk-by"
                  variant="secondary"
                  busy={startAudit.isPending}
                  onPress={() => startAudit.mutate('WALK_BY')}
                />
              ) : null}
              <Muted>
                You will be asked for a photograph of yourself first. Works with the radio
                off — everything is saved on this device.
              </Muted>
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
