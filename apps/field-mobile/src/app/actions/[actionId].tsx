import { useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { CorrectiveOption, EvidenceViewUrl, SSection } from '@audit5s/contracts';
import { awaitsResponse, sectionLabel } from '@audit5s/domain';
import { CameraCapture } from '../../components/camera-capture';
import { Button, Card, ErrorBanner, Field, Heading, Label, Muted, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import { readLocation } from '../../lib/capture/location';
import type { ProcessedImage } from '../../lib/capture/media';
import { uuidv7 } from '../../lib/db/audit.repository';
import {
  captureAfterPhoto,
  getLocalCorrectiveAction,
  statusLabel,
  submitLocalCorrectiveAction,
} from '../../lib/db/corrective-action.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { useSession } from '../../lib/session';
import { useSync } from '../../lib/sync/provider';
import { theme } from '../../lib/theme';

/**
 * One corrective action (§2.4 steps 6–9, §7.3).
 *
 * Option A is a name, a **live** after-photo and a description; Option B an explanation.
 * Either is saved on the device first and synced when there is signal — the camera is the
 * only way to a photograph here, as §12.10 requires, because `CameraCapture` is the only
 * capture path the app has.
 */
export default function CorrectiveActionScreen() {
  const { actionId } = useLocalSearchParams<{ actionId: string }>();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { user } = useSession();
  const { sync } = useSync();

  const [option, setOption] = useState<CorrectiveOption>('COMPLETED');
  // The attempt's id is minted when the form opens: the after-photo's key embeds it (§5.6).
  const [submissionId] = useState(() => uuidv7());
  const [name, setName] = useState(user?.fullName ?? '');
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<{ evidenceId: string; uri: string } | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const action = useQuery({
    queryKey: ['local', 'corrective-action', actionId],
    queryFn: () => getLocalCorrectiveAction(database, actionId),
  });

  // The before photo needs the network; offline, the item still reads without it.
  const before = useQuery({
    queryKey: ['evidence-view-url', action.data?.beforeEvidenceId],
    queryFn: () =>
      api.get<EvidenceViewUrl>(`/evidence/${action.data!.beforeEvidenceId}/view-url?variant=thumbnail`),
    enabled: Boolean(action.data?.beforeEvidenceId),
    retry: false,
  });

  const capture = useMutation({
    mutationFn: async (image: ProcessedImage) => {
      const location = await readLocation();
      const evidenceId = await captureAfterPhoto(database, {
        action: action.data!,
        submissionId,
        localFileUri: image.uri,
        byteSize: image.byteSize,
        width: image.width,
        height: image.height,
        checksumSha256: image.checksumSha256,
        location: location
          ? {
              latitude: location.latitude,
              longitude: location.longitude,
              accuracyM: location.accuracyM ?? null,
              provider: location.provider,
            }
          : null,
      });
      setPhoto({ evidenceId, uri: image.uri });
    },
    onSuccess: () => setCameraOpen(false),
  });

  const submit = useMutation({
    mutationFn: () =>
      submitLocalCorrectiveAction(database, {
        actionId,
        submissionId,
        option,
        ...(option === 'COMPLETED'
          ? { submittedByName: name.trim(), description: text.trim(), ...(photo ? { afterEvidenceId: photo.evidenceId } : {}) }
          : { explanation: text.trim() }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      void sync();
      router.back();
    },
  });

  if (action.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.brand} />
      </Screen>
    );
  }
  if (!action.data) return <Screen><Muted>This corrective action is not on the device.</Muted></Screen>;
  if (cameraOpen) {
    return (
      <CameraCapture
        prompt="Photograph the corrected condition"
        onCaptured={(image) => capture.mutateAsync(image)}
        onCancel={() => setCameraOpen(false)}
      />
    );
  }

  const item = action.data;
  const open = awaitsResponse(item.effectiveStatus) && !item.pendingSubmissionId;
  const ready =
    option === 'COMPLETED' ? Boolean(photo) && name.trim().length > 0 && text.trim().length > 0 : text.trim().length > 0;

  return (
    <Screen>
      <Stack.Screen options={{ title: `Zone ${item.zoneCode}` }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <Heading>
            Zone {item.zoneCode} — {item.zoneName}
          </Heading>
          <Muted>
            {item.questionGlobalOrder
              ? `${item.section ? `${sectionLabel(item.section as SSection)} · ` : ''}Q${item.questionGlobalOrder}: ${item.questionText ?? ''}`
              : 'Walk-by observation'}
          </Muted>
          {item.findingRemark && <Text style={styles.remark}>{item.findingRemark}</Text>}
          {before.data ? (
            <Image source={{ uri: before.data.url }} style={styles.photo} accessibilityLabel="Before photograph" />
          ) : (
            <Muted>{before.isLoading ? 'Loading the photograph…' : 'The photograph is shown when online.'}</Muted>
          )}
          <Muted>
            {statusLabel(item)}
            {item.dueAt ? ` · due ${new Date(item.dueAt).toLocaleDateString()}` : ''}
            {item.reopenCount > 0 ? ` · reopened ×${item.reopenCount}` : ''}
          </Muted>
        </Card>

        {open ? (
          <Card>
            <View style={styles.choice}>
              <Button
                title="Completed"
                variant={option === 'COMPLETED' ? 'primary' : 'secondary'}
                onPress={() => setOption('COMPLETED')}
              />
              <Button
                title="Not possible"
                variant={option === 'NOT_POSSIBLE' ? 'primary' : 'secondary'}
                onPress={() => setOption('NOT_POSSIBLE')}
              />
            </View>

            {option === 'COMPLETED' ? (
              <>
                <Field label="Your name" value={name} onChangeText={setName} />
                <Label>After photograph</Label>
                {photo ? (
                  <Image source={{ uri: photo.uri }} style={styles.photo} accessibilityLabel="After photograph" />
                ) : (
                  <Muted>A live photograph of the corrected condition is required.</Muted>
                )}
                <Button
                  title={photo ? 'Retake photograph' : 'Take photograph'}
                  variant="secondary"
                  onPress={() => setCameraOpen(true)}
                />
                <Field label="What was done" value={text} onChangeText={setText} multiline />
              </>
            ) : (
              <Field label="Why it is not possible" value={text} onChangeText={setText} multiline />
            )}

            <ErrorBanner message={submit.error?.message ?? capture.error?.message ?? null} />
            <Button
              title="Submit"
              busy={submit.isPending}
              onPress={() => ready && submit.mutate()}
            />
            {!ready && (
              <Muted>
                {option === 'COMPLETED'
                  ? 'Add your name, a photograph and a description to submit.'
                  : 'Explain why the fix is not possible to submit.'}
              </Muted>
            )}
          </Card>
        ) : (
          <Card>
            <Muted>
              {item.pendingSubmissionId
                ? 'Saved on this device. It will be sent when there is signal.'
                : 'Submitted. The Super Admin reviews it; if it is reopened it will appear here again.'}
            </Muted>
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { gap: theme.space.sm, paddingBottom: theme.space.xl },
  remark: { fontSize: theme.font.base, color: theme.color.text, marginTop: theme.space.xs },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: 8, marginVertical: theme.space.sm },
  choice: { flexDirection: 'row', gap: theme.space.sm, marginBottom: theme.space.sm },
});
