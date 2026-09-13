import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { EvidenceClassification } from '@audit5s/contracts';
import { zoneDisplayLabel } from '@audit5s/domain';
import { CameraCapture } from '../../components/camera-capture';
import { Button, Card, ErrorBanner, Muted, Screen } from '../../components/ui';
import { readLocation } from '../../lib/capture/location';
import type { ProcessedImage } from '../../lib/capture/media';
import {
  completeLocalZone,
  getLocalAuditZone,
  saveZoneRemark,
} from '../../lib/db/audit.repository';
import {
  captureLocalEvidence,
  deleteLocalEvidence,
  listLocalEvidenceForZone,
  setLocalSummaryFlag,
  updateLocalWalkByEvidence,
  zoneHasLocalEvidence,
} from '../../lib/db/evidence.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { createThemedStyles, useTheme, type GembaTheme } from '../../lib/theme';

const CLASSIFICATIONS: EvidenceClassification[] = ['GOOD', 'NONCONFORMITY', 'NEUTRAL'];

/** §2.7's offline walk-by: live photos first, then review, remarks and completion. */
export default function WalkByScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const { auditZoneId } = useLocalSearchParams<{ auditZoneId: string }>();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [classification, setClassification] = useState<EvidenceClassification>('NEUTRAL');
  const [zoneRemark, setZoneRemark] = useState('');

  const zone = useQuery({
    queryKey: ['local', 'audit-zone', auditZoneId],
    queryFn: async () => (await getLocalAuditZone(database, auditZoneId))[0] ?? null,
  });
  const photos = useQuery({
    queryKey: ['local', 'zone-evidence', auditZoneId],
    queryFn: () => listLocalEvidenceForZone(database, auditZoneId),
  });

  useEffect(() => setZoneRemark(zone.data?.zoneRemark ?? ''), [zone.data?.zoneRemark]);

  const capture = useMutation({
    mutationFn: async (image: ProcessedImage) => {
      const location = await readLocation();
      await captureLocalEvidence(database, {
        auditId: zone.data!.auditId,
        auditZoneId,
        kind: 'WALK_BY_PHOTO',
        classification,
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
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      setCameraOpen(false);
    },
  });

  const finish = useMutation({
    mutationFn: async () => {
      if (!(await zoneHasLocalEvidence(database, auditZoneId))) {
        throw new Error('Take at least one photograph before finishing this Zone.');
      }
      await saveZoneRemark(database, auditZoneId, zoneRemark.trim() || null);
      await completeLocalZone(database, auditZoneId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      router.back();
    },
  });

  if (zone.isLoading || photos.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.ink} />
      </Screen>
    );
  }
  if (!zone.data) return <Screen><Muted>This walk-by Zone is not on the device.</Muted></Screen>;
  if (cameraOpen) {
    return (
      <CameraCapture
        prompt={`Capture a ${classificationLabel(classification).toLowerCase()} observation`}
        onCaptured={(image) => capture.mutateAsync(image)}
        onCancel={() => setCameraOpen(false)}
      />
    );
  }

  const editable = zone.data.status !== 'COMPLETED';
  const title = zoneDisplayLabel(zone.data.zoneCodeSnapshot, zone.data.zoneNameSnapshot);

  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          {zone.data.zoneDescriptionSnapshot ? <Text style={styles.body}>{zone.data.zoneDescriptionSnapshot}</Text> : null}
          <Muted>
            {zone.data.zoneLeaderNameSnapshot
              ? `Zone Leader: ${zone.data.zoneLeaderNameSnapshot}`
              : 'No Zone Leader recorded'}
          </Muted>
        </Card>

        {editable ? (
          <Card style={styles.captureCard}>
            <Text style={styles.heading}>Classify the next photograph</Text>
            <ClassificationChoices value={classification} onChange={setClassification} />
            <Button title={photos.data?.length ? 'Take another photo' : 'Open camera'} onPress={() => setCameraOpen(true)} />
            <Muted>Live camera only. Photos may include people and are retained as audit records.</Muted>
          </Card>
        ) : null}

        <Text style={styles.heading}>Evidence preview</Text>
        {(photos.data ?? []).length === 0 ? <Muted>No photographs yet. At least one is required.</Muted> : null}
        {(photos.data ?? []).map((photo) => (
          <PhotoCard key={photo.id} photo={photo} editable={editable} />
        ))}

        {editable ? (
          <Card>
            <Text style={styles.fieldLabel}>Zone remark (optional)</Text>
            <TextInput
              multiline
              style={styles.input}
              value={zoneRemark}
              onChangeText={setZoneRemark}
              placeholder="Overall observation for this Zone"
              placeholderTextColor={theme.color.ink2}
            />
          </Card>
        ) : zone.data.zoneRemark ? (
          <Card><Text style={styles.body}>{zone.data.zoneRemark}</Text></Card>
        ) : null}

        <ErrorBanner message={finish.error instanceof Error ? finish.error.message : null} />
        {editable ? <Button title="Save Zone" busy={finish.isPending} onPress={() => finish.mutate()} /> : null}
        <Muted>Saved on this device. Sync uses the same outbox as every other audit.</Muted>
      </ScrollView>
    </Screen>
  );
}

type Photo = Awaited<ReturnType<typeof listLocalEvidenceForZone>>[number];

function PhotoCard({ photo, editable }: { photo: Photo; editable: boolean }) {
  const styles = useStyles();
  const theme = useTheme();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const [remark, setRemark] = useState(photo.remark ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setRemark(photo.remark ?? ''), [photo.remark]);

  const patch = useMutation({
    mutationFn: (change: { classification?: EvidenceClassification; remark?: string | null }) =>
      updateLocalWalkByEvidence(database, photo.id, change),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError('That classification already has a summary photograph in this Zone.');
        return;
      }
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });
  const flag = useMutation({
    mutationFn: () => setLocalSummaryFlag(database, photo.id, photo.isSummaryFlagged !== 1),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(
          result.reason === 'NEUTRAL'
            ? 'Classify this photograph as GOOD or NONCONFORMITY before flagging it.'
            : 'That classification already has a summary photograph in this Zone.',
        );
        return;
      }
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteLocalEvidence(database, photo.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local'] }),
  });

  return (
    <Card style={styles.photoCard}>
      {photo.localFileUri ? (
        <Image source={{ uri: photo.localFileUri }} style={styles.photo} resizeMode="cover" />
      ) : (
        <View style={[styles.photo, styles.missing]}><Muted>Preview no longer stored locally</Muted></View>
      )}
      <View style={styles.photoHeader}>
        <Text style={[styles.classification, { color: classificationColor(photo.classification, theme) }]}>
          {classificationLabel(photo.classification as EvidenceClassification)}
        </Text>
        {photo.isSummaryFlagged === 1 ? <Text style={styles.flagged}>Summary photo</Text> : null}
      </View>

      {editable ? (
        <>
          <ClassificationChoices
            value={photo.classification as EvidenceClassification}
            onChange={(value) => patch.mutate({ classification: value })}
          />
          <TextInput
            multiline
            style={styles.input}
            value={remark}
            onChangeText={setRemark}
            placeholder="Photo remark (optional)"
            placeholderTextColor={theme.color.ink2}
          />
          <Button title="Save remark" variant="secondary" busy={patch.isPending} onPress={() => patch.mutate({ remark: remark.trim() || null })} />
          <Button
            title={photo.isSummaryFlagged === 1 ? 'Remove summary flag' : 'Flag for summary'}
            variant="secondary"
            busy={flag.isPending}
            onPress={() => flag.mutate()}
          />
          <Button title="Delete photo" variant="secondary" busy={remove.isPending} onPress={() => remove.mutate()} />
        </>
      ) : photo.remark ? <Muted>{photo.remark}</Muted> : null}
      <ErrorBanner message={error} />
    </Card>
  );
}

function ClassificationChoices({
  value,
  onChange,
}: {
  value: EvidenceClassification;
  onChange: (value: EvidenceClassification) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.choices}>
      {CLASSIFICATIONS.map((classification) => (
        <Pressable
          key={classification}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === classification }}
          onPress={() => onChange(classification)}
          style={[styles.choice, value === classification && styles.choiceSelected]}
        >
          <Text style={{ color: classificationColor(classification, theme), fontFamily: theme.family.medium }}>
            {classificationLabel(classification)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function classificationLabel(value: EvidenceClassification): string {
  return value === 'NONCONFORMITY' ? 'Nonconformity' : value === 'GOOD' ? 'Good' : 'Neutral';
}

function classificationColor(value: string, theme: GembaTheme): string {
  return value === 'GOOD' ? theme.color.ok : value === 'NONCONFORMITY' ? theme.color.crit : theme.color.ink2;
}

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { gap: theme.space.sm, paddingBottom: theme.space.xl },
  heading: { fontFamily: theme.family.bold, fontSize: theme.font.panel, color: theme.color.ink, textTransform: 'uppercase' },
  body: { fontFamily: theme.family.regular, color: theme.color.ink, fontSize: theme.font.base },
  captureCard: { gap: theme.space.sm },
  choices: { flexDirection: 'row', gap: theme.space.xs },
  choice: { flex: 1, minHeight: 48, justifyContent: 'center', alignItems: 'center', borderWidth: 1.5, borderColor: theme.color.edge, padding: theme.space.sm },
  choiceSelected: { borderColor: theme.color.accent, borderLeftWidth: 6, backgroundColor: theme.color.accentSoft },
  photoCard: { gap: theme.space.sm },
  photo: { width: '100%', aspectRatio: 4 / 3, backgroundColor: theme.color.tile2, borderWidth: 1, borderColor: theme.color.edge },
  missing: { alignItems: 'center', justifyContent: 'center' },
  photoHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  classification: { fontFamily: theme.family.bold, textTransform: 'uppercase' },
  flagged: { color: theme.color.accent, fontFamily: theme.family.bold, fontSize: theme.font.label, textTransform: 'uppercase', borderWidth: 1.5, borderColor: theme.color.accent, paddingHorizontal: 7, paddingVertical: 2 },
  fieldLabel: { fontFamily: theme.family.medium, fontSize: theme.font.label, color: theme.color.ink3, marginBottom: theme.space.xs, textTransform: 'uppercase', letterSpacing: 1.1 },
  input: { minHeight: 72, borderWidth: 1.5, borderColor: theme.color.edge, padding: theme.space.md, fontFamily: theme.family.regular, color: theme.color.ink, backgroundColor: theme.color.tile2, textAlignVertical: 'top' },
}));
