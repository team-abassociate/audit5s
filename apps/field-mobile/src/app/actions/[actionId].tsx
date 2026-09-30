import { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Image, ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { HeaderBackButton } from 'expo-router/react-navigation';
import type { CorrectiveOption, EvidenceViewUrl, SSection } from '@audit5s/contracts';
import { awaitsResponse, sectionLabel } from '@audit5s/domain';
import { CameraCapture } from '../../components/camera-capture';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Data,
  ErrorBanner,
  Field,
  Label,
  Muted,
  Screen,
} from '../../components/ui';
import { api } from '../../lib/api';
import { useRequiredFields } from '../../lib/required-fields';
import type { ProcessedImage } from '../../lib/capture/media';
import { uuidv7 } from '../../lib/db/audit.repository';
import {
  captureAfterPhoto,
  getLocalCorrectiveAction,
  statusLabel,
  submitLocalCorrectiveAction,
} from '../../lib/db/corrective-action.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { formatDate } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useSync } from '../../lib/sync/provider';
import { createThemedStyles, useTheme } from '../../lib/theme';
import { leaveScreen } from '../../lib/leave-screen';

/**
 * One corrective action (§2.4 steps 6–9, §7.3).
 *
 * Option A is a name, a **live** after-photo and a description; Option B an explanation.
 * Either is saved on the device first and synced when there is signal — the camera is the
 * only way to a photograph here, as §12.10 requires, because `CameraCapture` is the only
 * capture path the app has.
 *
 * An **overall** action (R-38) — the auditor's suggestion for the Zone as a whole — is
 * answered with what was done, and its photograph is optional: some fixes, a smell, cannot
 * be photographed. The report's link offers the gallery as well; this screen keeps to the
 * in-app camera, the only capture path the app has.
 */
export default function CorrectiveActionScreen() {
  const styles = useStyles();
  const theme = useTheme();
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
  const required = useRequiredFields<'name' | 'photo' | 'text'>();

  // Back over the camera closes the camera and returns to the response, never leaves it.
  useEffect(() => {
    if (!cameraOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setCameraOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [cameraOpen]);

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
      const evidenceId = await captureAfterPhoto(database, {
        action: action.data!,
        submissionId,
        localFileUri: image.uri,
        byteSize: image.byteSize,
        width: image.width,
        height: image.height,
        checksumSha256: image.checksumSha256,
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
    onSuccess: () => {
      leaveScreen(
        () => router.back(),
        () => {
          void queryClient.invalidateQueries({ queryKey: ['local'] });
          void sync();
        },
      );
    },
  });

  if (action.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.ink} />
      </Screen>
    );
  }
  if (!action.data) return <Screen><Muted>This corrective action is not on the device.</Muted></Screen>;
  if (cameraOpen) {
    return (
      <>
        <Stack.Screen
          options={{
            headerLeft: ({ tintColor }) => (
              <HeaderBackButton tintColor={tintColor} onPress={() => setCameraOpen(false)} />
            ),
          }}
        />
        <CameraCapture
          prompt="Photograph the corrected condition"
          onCaptured={(image) => capture.mutateAsync(image)}
          onCancel={() => setCameraOpen(false)}
        />
      </>
    );
  }

  const item = action.data;
  const overall = item.suggestion !== null;
  const open = awaitsResponse(item.effectiveStatus) && !item.pendingSubmissionId;
  const nameGiven = name.trim().length > 0;
  const textGiven = text.trim().length > 0;
  const trySubmit = () => {
    const complete =
      option === 'COMPLETED'
        ? required.check([
            ['name', nameGiven],
            // Optional for an overall action (R-38).
            ['photo', overall || Boolean(photo)],
            ['text', textGiven],
          ])
        : required.check([['text', textGiven]]);
    if (complete) submit.mutate();
  };
  const facts = [
    item.dueAt ? `Due ${formatDate(item.dueAt)}` : null,
    item.reopenCount > 0 ? `Reopened ×${item.reopenCount}` : null,
  ].filter(Boolean);

  return (
    <Screen>
      {/* `headerLeft: undefined` puts the ordinary back arrow back after the camera's. */}
      <Stack.Screen options={{ title: `Zone ${item.zoneCode}`, headerLeft: undefined }} />
      <ScrollView ref={required.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card rail={open ? 'warn' : 'none'}>
          <CardHeader
            title={`Zone ${item.zoneCode} — ${item.zoneName}`}
            description={
              overall
                ? `Overall corrective action ${item.suggestionNo ?? ''}`
                : item.questionGlobalOrder
                  ? `${item.section ? `${sectionLabel(item.section as SSection)} · ` : ''}Q${item.questionGlobalOrder}: ${item.questionText ?? ''}`
                  : 'Walk-by observation'
            }
            action={<Chip tone={open ? 'warn' : 'muted'}>{statusLabel(item)}</Chip>}
          />
          {overall ? (
            <View style={styles.block}>
              <Label>Suggested by the auditor</Label>
              <Text style={styles.remark}>{item.suggestion}</Text>
            </View>
          ) : (
            <>
              {item.findingRemark ? (
                <View style={styles.block}>
                  <Label>Finding</Label>
                  <Text style={styles.remark}>{item.findingRemark}</Text>
                </View>
              ) : null}
              <Label>Before</Label>
              {before.data ? (
                <Image source={{ uri: before.data.url }} style={styles.photo} accessibilityLabel="Before photograph" />
              ) : (
                <View style={styles.placeholder}>
                  <Muted>{before.isLoading ? 'Loading the photograph…' : 'The photograph is shown when online.'}</Muted>
                </View>
              )}
            </>
          )}
          {facts.length > 0 ? <Data>{facts.join(', ')}</Data> : null}
        </Card>

        {open ? (
          <Card>
            <CardHeader
              title="Your response"
              description="Saved on this device first, then sent when there is signal."
            />
            {overall ? null : (
              <View style={styles.choice}>
                <View style={styles.choiceItem}>
                  <Button
                    title="Completed"
                    variant={option === 'COMPLETED' ? 'primary' : 'secondary'}
                    onPress={() => setOption('COMPLETED')}
                  />
                </View>
                <View style={styles.choiceItem}>
                  <Button
                    title="Not possible"
                    variant={option === 'NOT_POSSIBLE' ? 'primary' : 'secondary'}
                    onPress={() => setOption('NOT_POSSIBLE')}
                  />
                </View>
              </View>
            )}

            {option === 'COMPLETED' ? (
              <>
                <Field
                  label="Your name"
                  inputRef={required.input('name')}
                  error={required.error('name', 'Enter your name.', nameGiven)}
                  value={name}
                  onChangeText={setName}
                />
                <View ref={required.anchor('photo')} collapsable={false}>
                <Label>{overall ? 'After photograph (optional)' : 'After photograph'}</Label>
                {required.flagged('photo', overall || Boolean(photo)) ? (
                  <ErrorBanner message="Take a photograph of the corrected condition." />
                ) : null}
                {photo ? (
                  <Image source={{ uri: photo.uri }} style={styles.photo} accessibilityLabel="After photograph" />
                ) : (
                  <View style={styles.placeholder}>
                    <Muted>
                      {overall
                        ? 'If the fix cannot be photographed, leave this empty.'
                        : 'A live photograph of the corrected condition is required.'}
                    </Muted>
                  </View>
                )}
                <View style={styles.block}>
                  <Button
                    title={photo ? 'Retake photograph' : 'Take photograph'}
                    variant="secondary"
                    onPress={() => setCameraOpen(true)}
                  />
                </View>
                </View>
                <Field
                  label={overall ? 'Corrective action taken' : 'What was done'}
                  inputRef={required.input('text')}
                  error={required.error('text', 'Describe what was done.', textGiven)}
                  value={text}
                  onChangeText={setText}
                  multiline
                />
              </>
            ) : (
              <Field
                label="Why it is not possible"
                inputRef={required.input('text')}
                error={required.error('text', 'Explain why the fix is not possible.', textGiven)}
                value={text}
                onChangeText={setText}
                multiline
              />
            )}

            <ErrorBanner message={submit.error?.message ?? capture.error?.message ?? null} />
            <Button title="Submit" busy={submit.isPending} onPress={trySubmit} />
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

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { paddingBottom: theme.space.xl },
  block: { marginBottom: theme.space.md },
  remark: { fontFamily: theme.family.regular, fontSize: theme.font.base, lineHeight: 22, color: theme.color.ink },
  photo: {
    width: '100%',
    aspectRatio: 4 / 3,
    marginBottom: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile2,
  },
  placeholder: {
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.space.md,
    marginBottom: theme.space.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile2,
  },
  choice: { flexDirection: 'row', gap: theme.space.sm, marginBottom: theme.space.md },
  choiceItem: { flex: 1 },
}));
