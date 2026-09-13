import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { EvidenceClassification } from '@audit5s/contracts';
import { zoneDisplayLabel } from '@audit5s/domain';
import { CameraCapture } from '../../components/camera-capture';
import {
  ActionBar,
  Button,
  Card,
  CardHeader,
  Chip,
  ErrorBanner,
  Field,
  Label,
  Muted,
  Screen,
  SectionHead,
} from '../../components/ui';
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
import { bandInk, createThemedStyles, useTheme, type Band } from '../../lib/theme';

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
  const count = photos.data?.length ?? 0;

  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card>
          {zone.data.zoneDescriptionSnapshot ? <Text style={styles.body}>{zone.data.zoneDescriptionSnapshot}</Text> : null}
          <Muted>
            {zone.data.zoneLeaderNameSnapshot
              ? `Zone Leader: ${zone.data.zoneLeaderNameSnapshot}`
              : 'No Zone Leader recorded'}
          </Muted>
        </Card>

        {editable ? (
          <Card>
            <CardHeader
              title="Classify the next photograph"
              description="Live camera only. Photos may include people and are retained as audit records."
            />
            <View style={styles.stack}>
              <ClassificationChoices value={classification} onChange={setClassification} />
              <Button title={count ? 'Take another photo' : 'Open camera'} onPress={() => setCameraOpen(true)} />
            </View>
          </Card>
        ) : null}

        <SectionHead
          title="Evidence"
          description={
            count === 0
              ? 'No photographs yet. At least one is required.'
              : `${count} photograph${count === 1 ? '' : 's'} in this Zone.`
          }
        />
        {(photos.data ?? []).map((photo) => (
          <PhotoCard key={photo.id} photo={photo} editable={editable} />
        ))}

        {editable ? (
          <Card>
            <Field
              label="Zone remark (optional)"
              multiline
              value={zoneRemark}
              onChangeText={setZoneRemark}
              placeholder="Overall observation for this Zone"
              containerStyle={styles.lastField}
            />
          </Card>
        ) : zone.data.zoneRemark ? (
          <Card>
            <Label>Zone remark</Label>
            <Text style={styles.body}>{zone.data.zoneRemark}</Text>
          </Card>
        ) : null}

        <ErrorBanner message={finish.error instanceof Error ? finish.error.message : null} />
        <Muted>Saved on this device. Sync uses the same outbox as every other audit.</Muted>
      </ScrollView>
      {editable ? (
        <ActionBar>
          <Button title="Save Zone" busy={finish.isPending} onPress={() => finish.mutate()} />
        </ActionBar>
      ) : null}
    </Screen>
  );
}

type Photo = Awaited<ReturnType<typeof listLocalEvidenceForZone>>[number];

function PhotoCard({ photo, editable }: { photo: Photo; editable: boolean }) {
  const styles = useStyles();
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

  const label = classificationLabel(photo.classification as EvidenceClassification);

  return (
    <Card>
      {photo.localFileUri ? (
        <Image
          source={{ uri: photo.localFileUri }}
          style={styles.photo}
          resizeMode="cover"
          accessibilityLabel={`${label} photograph`}
        />
      ) : (
        <View style={styles.placeholder}><Muted>Preview no longer stored locally</Muted></View>
      )}
      <View style={styles.photoHeader}>
        <Chip tone={classificationTone(photo.classification)}>{label}</Chip>
        {photo.isSummaryFlagged === 1 ? <Chip>Summary photo</Chip> : null}
      </View>

      {editable ? (
        <View style={styles.stack}>
          <ClassificationChoices
            value={photo.classification as EvidenceClassification}
            onChange={(value) => patch.mutate({ classification: value })}
          />
          <Field
            label="Photo remark (optional)"
            multiline
            value={remark}
            onChangeText={setRemark}
            containerStyle={styles.lastField}
          />
          <Button title="Save remark" variant="secondary" busy={patch.isPending} onPress={() => patch.mutate({ remark: remark.trim() || null })} />
          <Button
            title={photo.isSummaryFlagged === 1 ? 'Remove summary flag' : 'Flag for summary'}
            variant="secondary"
            busy={flag.isPending}
            onPress={() => flag.mutate()}
          />
          <Button title="Delete photo" variant="danger" busy={remove.isPending} onPress={() => remove.mutate()} />
        </View>
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
    <View style={styles.choices} accessibilityRole="radiogroup">
      {CLASSIFICATIONS.map((classification) => {
        const tone = classificationTone(classification);
        return (
          <Pressable
            key={classification}
            accessibilityRole="radio"
            accessibilityState={{ checked: value === classification }}
            onPress={() => onChange(classification)}
            style={[styles.choice, value === classification && styles.choiceSelected]}
          >
            <Text
              style={[
                styles.choiceText,
                { color: tone === 'muted' ? theme.color.ink2 : bandInk(tone, theme.color) },
              ]}
            >
              {classificationLabel(classification)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function classificationLabel(value: EvidenceClassification): string {
  return value === 'NONCONFORMITY' ? 'Nonconformity' : value === 'GOOD' ? 'Good' : 'Neutral';
}

function classificationTone(value: string): Band | 'muted' {
  return value === 'GOOD' ? 'ok' : value === 'NONCONFORMITY' ? 'crit' : 'muted';
}

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { gap: theme.space.sm, paddingBottom: theme.space.lg },
  body: { fontFamily: theme.family.regular, color: theme.color.ink, fontSize: theme.font.base, lineHeight: 22 },
  stack: { gap: theme.space.sm },
  lastField: { marginBottom: 0 },
  choices: { flexDirection: 'row', gap: theme.space.xs },
  choice: {
    flex: 1,
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile,
    padding: theme.space.sm,
  },
  // Selection is the one place the accent belongs (GEMBA-BOARD.md non-negotiable 6).
  choiceSelected: { borderColor: theme.color.accent, borderLeftWidth: 6, backgroundColor: theme.color.accentSoft },
  choiceText: { fontFamily: theme.family.medium, fontSize: theme.font.sm },
  photo: {
    width: '100%',
    aspectRatio: 4 / 3,
    backgroundColor: theme.color.tile2,
    borderWidth: 1,
    borderColor: theme.color.edge,
    marginBottom: theme.space.sm,
  },
  placeholder: {
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.color.tile2,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.color.edge,
    marginBottom: theme.space.sm,
  },
  photoHeader: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, marginBottom: theme.space.sm },
}));
