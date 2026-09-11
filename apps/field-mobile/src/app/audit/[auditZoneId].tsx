import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { ResponseValue, SSection } from '@audit5s/contracts';
import { S_SECTION_LABELS, TOTAL_QUESTIONS, bandFor } from '@audit5s/domain';
import { Button, Card, Muted, Screen } from '../../components/ui';
import { CameraCapture } from '../../components/camera-capture';
import {
  captureLocalEvidence,
  listLocalEvidenceForZone,
  reclassifyLocalEvidence,
  responseIdFor,
} from '../../lib/db/evidence.repository';
import { readLocation } from '../../lib/capture/location';
import type { ProcessedImage } from '../../lib/capture/media';
import { ResponseChips } from '../../components/response-chips';
import {
  completeLocalZone,
  getLocalAuditZone,
  listQuestionsWithAnswers,
  pauseLocalAudit,
  saveLocalResponse,
  saveZoneRemark,
  scoreLocalZone,
} from '../../lib/db/audit.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { theme } from '../../lib/theme';

/**
 * The questionnaire: 5 sections × 10, one question on screen at a time.
 *
 * **Nothing here awaits the network.** Every handler writes to SQLite and returns; the
 * screen advances on the commit, not on a response. That is not an optimisation — §9.1
 * makes the local store the source of truth while an audit is in progress, and an auditor
 * standing in a press shop with no signal has to be able to finish.
 *
 * The score in the footer is `scoreZone` from `@audit5s/domain`, the same function the
 * server runs on the way in (D5). What the auditor sees offline is what the report will
 * say, which is the Phase 3 acceptance row.
 */
export default function QuestionnaireScreen() {
  const { auditZoneId } = useLocalSearchParams<{ auditZoneId: string }>();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [index, setIndex] = useState(0);
  const [remarkDraft, setRemarkDraft] = useState('');
  const [zoneRemarkDraft, setZoneRemarkDraft] = useState('');
  const [showingSummary, setShowingSummary] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);

  const zone = useQuery({
    queryKey: ['local', 'audit-zone', auditZoneId],
    queryFn: async () => (await getLocalAuditZone(database, auditZoneId))[0] ?? null,
  });

  const questions = useQuery({
    enabled: Boolean(zone.data?.checklistVersionId),
    queryKey: ['local', 'questionnaire', auditZoneId, zone.data?.checklistVersionId],
    queryFn: () =>
      listQuestionsWithAnswers(database, auditZoneId, zone.data!.checklistVersionId!),
  });

  const score = useQuery({
    queryKey: ['local', 'zone-score', auditZoneId],
    queryFn: () => scoreLocalZone(database, auditZoneId),
  });

  // Resume where the auditor stopped (§9.8). Entirely local: no round trip, so this works
  // three days later in a plant with no signal.
  useEffect(() => {
    const rows = questions.data;
    const cursor = zone.data?.resumeQuestionId;
    if (!rows || !cursor) return;
    const position = rows.findIndex((row) => row.questionId === cursor);
    if (position >= 0) setIndex(position);
  }, [questions.data, zone.data?.resumeQuestionId]);

  const rows = questions.data ?? [];
  const current = rows[index];

  const photos = useQuery({
    queryKey: ['local', 'zone-evidence', auditZoneId],
    queryFn: () => listLocalEvidenceForZone(database, auditZoneId),
  });

  useEffect(() => {
    setRemarkDraft(current?.remark ?? '');
  }, [current?.questionId, current?.remark]);

  useEffect(() => {
    setZoneRemarkDraft(zone.data?.zoneRemark ?? '');
  }, [zone.data?.zoneRemark]);

  const answeredCount = useMemo(
    () => rows.filter((row) => row.value !== null).length,
    [rows],
  );

  const save = useMutation({
    mutationFn: async (input: { value: ResponseValue; remark: string | null }) => {
      if (!current) return;
      // SQLite commits before this resolves; the UI is free the moment it does.
      const responseId = await saveLocalResponse(database, {
        auditZoneId,
        auditId: zone.data!.auditId,
        checklistQuestionId: current.questionId,
        section: current.section as SSection,
        globalOrder: current.globalOrder,
        value: input.value,
        remark: input.remark,
      });

      // E-2, on the device: a photograph already attached to this question is re-filed to
      // match the answer as it now stands. The server does this authoritatively inside its
      // own transaction; doing it here means the badge under the question is right
      // *before* the sync, and an auditor who marks a question down never sees a green
      // tick that contradicts them.
      await reclassifyLocalEvidence(database, responseId, input.value);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });

  const finish = useMutation({
    mutationFn: async () => {
      await saveZoneRemark(database, auditZoneId, zoneRemarkDraft.trim() || null);
      await completeLocalZone(database, auditZoneId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      router.back();
    },
  });

  /**
   * A photograph for the question on screen (§9.4).
   *
   * The classification is derived from the answer as it stands — `classifyEvidence` again,
   * the same function the server runs — so the tick or the warning appears the instant the
   * shutter closes, offline, and matches what the report will print.
   */
  const capture = useMutation({
    mutationFn: async (image: ProcessedImage) => {
      const responseId = await responseIdFor(database, auditZoneId, current!.questionId);
      const location = await readLocation();

      await captureLocalEvidence(database, {
        auditId: zone.data!.auditId,
        auditZoneId,
        kind: 'QUESTION_EVIDENCE',
        ...(responseId ? { questionResponseId: responseId } : {}),
        scoreAtCapture: (current!.value as ResponseValue | null) ?? null,
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

  const abort = useMutation({
    mutationFn: () => pauseLocalAudit(database, zone.data!.auditId, 'Aborted by auditor'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      router.back();
    },
  });

  if (zone.isLoading || questions.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.brand} />
      </Screen>
    );
  }

  if (!zone.data) {
    return (
      <Screen>
        <Muted>This Zone is not on the device.</Muted>
      </Screen>
    );
  }

  const title = `${zone.data.zoneCodeSnapshot} — ${zone.data.zoneNameSnapshot}`;

  if (showingSummary) {
    return (
      <Screen>
        <Stack.Screen options={{ title }} />
        <ScrollView contentContainerStyle={styles.summary}>
          <Text style={styles.sectionTitle}>Finish Zone</Text>
          <ScoreCard breakdown={score.data} answered={answeredCount} />

          <Card>
            <Text style={styles.label}>Overall remark (optional)</Text>
            <TextInput
              style={styles.remarkInput}
              multiline
              placeholder="Anything the report should carry about this Zone"
              placeholderTextColor={theme.color.textMuted}
              value={zoneRemarkDraft}
              onChangeText={setZoneRemarkDraft}
            />
          </Card>

          {answeredCount < rows.length ? (
            <Muted>
              {rows.length - answeredCount} of {rows.length} questions are still unanswered.
              Every question needs an answer before the Zone can be finished.
            </Muted>
          ) : null}

          <Button
            title="Finish Zone"
            busy={finish.isPending}
            onPress={() => finish.mutate()}
          />
          <Button title="Back to questions" variant="secondary" onPress={() => setShowingSummary(false)} />
        </ScrollView>
      </Screen>
    );
  }

  if (!current) {
    return (
      <Screen>
        <Muted>This Zone has no checklist pinned to it.</Muted>
      </Screen>
    );
  }

  if (cameraOpen) {
    return (
      <CameraCapture
        prompt={`Photograph for question ${current.globalOrder}`}
        onCaptured={async (image) => {
          await capture.mutateAsync(image);
        }}
        onCancel={() => setCameraOpen(false)}
      />
    );
  }

  const photosHere = (photos.data ?? []).filter(
    (photo) => photo.questionResponseId !== null && photo.scoreAtCapture !== undefined,
  );

  return (
    <Screen>
      <Stack.Screen options={{ title }} />

      <View style={styles.progressRow}>
        <Text style={styles.progressText}>
          {current.globalOrder} of {rows.length || TOTAL_QUESTIONS}
        </Text>
        <Text style={styles.sectionLabel}>{S_SECTION_LABELS[current.section as SSection]}</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${(answeredCount / (rows.length || 1)) * 100}%` }]} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Card>
          <Text style={styles.question}>{current.text}</Text>
          {current.guidance ? <Muted>{current.guidance}</Muted> : null}
        </Card>

        <ResponseChips
          value={(current.value as ResponseValue | null) ?? null}
          allowsNa={current.allowsNa === 1}
          onChange={(value) => {
            save.mutate({ value, remark: remarkDraft.trim() || null });
            // Advance immediately. The write has committed by the time the mutation
            // resolves, and waiting for it would make the questionnaire feel networked.
            if (index < rows.length - 1) setIndex(index + 1);
          }}
        />

        <Card>
          <Text style={styles.label}>Evidence</Text>
          <Muted>
            {photosHere.length === 0
              ? 'No photographs for this Zone yet.'
              : `${photosHere.length} photograph${photosHere.length === 1 ? '' : 's'} in this Zone.`}
          </Muted>
          <Button
            title="Take a photograph"
            variant="secondary"
            onPress={() => setCameraOpen(true)}
          />
        </Card>

        <Card>
          <Text style={styles.label}>Remark (optional)</Text>
          <TextInput
            style={styles.remarkInput}
            multiline
            placeholder="What you saw, in your words"
            placeholderTextColor={theme.color.textMuted}
            value={remarkDraft}
            onChangeText={setRemarkDraft}
            onBlur={() => {
              if (current.value) {
                save.mutate({
                  value: current.value as ResponseValue,
                  remark: remarkDraft.trim() || null,
                });
              }
            }}
          />
        </Card>

        <ScoreCard breakdown={score.data} answered={answeredCount} />
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.navRow}>
          <View style={styles.navButton}>
            <Button
              title="Previous"
              variant="secondary"
              onPress={() => setIndex(Math.max(0, index - 1))}
            />
          </View>
          <View style={styles.navButton}>
            <Button
              title={index >= rows.length - 1 ? 'Review' : 'Next'}
              onPress={() =>
                index >= rows.length - 1 ? setShowingSummary(true) : setIndex(index + 1)
              }
            />
          </View>
        </View>
        {/* N7: abort saves and pauses. It never discards, and it never waits. */}
        <Button title="Abort — save and pause" variant="secondary" onPress={() => abort.mutate()} />
        <Muted>Saved on this device. Syncing happens when there is a connection.</Muted>
      </View>
    </Screen>
  );
}

/**
 * The live score, from the shared domain function.
 *
 * `null` renders `N/A` rather than `0%` (D4): a Zone whose answered questions are all NA
 * has no percentage, and showing zero would tell the auditor they had failed.
 */
function ScoreCard({
  breakdown,
  answered,
}: {
  breakdown: Awaited<ReturnType<typeof scoreLocalZone>> | undefined;
  answered: number;
}) {
  if (!breakdown) return null;
  const percentage = breakdown.totals.scorePercentage;
  const band = bandFor(percentage);

  return (
    <Card>
      <Text style={styles.label}>Score so far</Text>
      <Text style={[styles.score, band ? { color: band.color } : null]}>
        {percentage === null ? 'N/A' : `${percentage.toFixed(1)}%`}
      </Text>
      <Muted>
        {breakdown.totals.rawScore} / {breakdown.totals.maxScore} marks · {answered} answered ·{' '}
        {breakdown.totals.naQuestions} NA
        {band ? ` · ${band.label}` : ''}
      </Muted>
    </Card>
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: 'center', justifyContent: 'center' },
  body: { gap: theme.space.sm, paddingBottom: theme.space.lg },
  summary: { gap: theme.space.md, paddingBottom: theme.space.xl },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: theme.space.xs },
  progressText: { fontSize: theme.font.sm, fontWeight: '700', color: theme.color.text },
  sectionLabel: { fontSize: theme.font.sm, color: theme.color.textMuted },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.color.border,
    marginBottom: theme.space.md,
    overflow: 'hidden',
  },
  progressFill: { height: 4, backgroundColor: theme.color.brand },
  question: { fontSize: theme.font.lg, fontWeight: '600', color: theme.color.text },
  label: {
    fontSize: theme.font.sm,
    fontWeight: '600',
    color: theme.color.textMuted,
    marginBottom: theme.space.xs,
  },
  remarkInput: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    padding: theme.space.sm,
    minHeight: 64,
    color: theme.color.text,
    textAlignVertical: 'top',
  },
  score: { fontSize: theme.font.xl, fontWeight: '700', color: theme.color.text },
  sectionTitle: { fontSize: theme.font.xl, fontWeight: '700', color: theme.color.text },
  footer: { gap: theme.space.sm, paddingTop: theme.space.sm },
  navRow: { flexDirection: 'row', gap: theme.space.sm },
  navButton: { flex: 1 },
});
