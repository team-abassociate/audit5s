import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, Pressable, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { ResponseValue, SSection } from '@audit5s/contracts';
import {
  RESPONSE_TOKENS,
  S_SECTION_LABELS,
  S_SECTION_SHORT_LABELS,
  TOTAL_QUESTIONS,
  bandFor,
  zoneDisplayLabel,
} from '@audit5s/domain';
import {
  ActionBar,
  Button,
  Card,
  CardHeader,
  Chip,
  ErrorBanner,
  Field,
  Figure,
  HeaderAction,
  Label,
  Muted,
  Screen,
  SectionHead,
  SectionRows,
  Slip,
  SlipText,
  StatusBand,
} from '../../components/ui';
import { CameraCapture } from '../../components/camera-capture';
import {
  PhotoPreview,
  PhotoThumbs,
  SummaryPhotosCard,
  type LocalPhoto,
} from '../../components/evidence-photos';
import { ResponseChips } from '../../components/response-chips';
import {
  assertZonePhotoCapacity,
  assertZonePhotoLimitForCompletion,
  captureLocalEvidence,
  listLocalEvidenceForZone,
  reclassifyLocalEvidence,
  responseIdFor,
} from '../../lib/db/evidence.repository';
import { ZONE_PHOTO_LIMIT, ZONE_PHOTO_LIMIT_MESSAGE, isZoneAuditPhoto } from '../../lib/db/photo-limit';
import { readLocation } from '../../lib/capture/location';
import type { ProcessedImage } from '../../lib/capture/media';
import {
  applyLocalOverride,
  completeLocalZone,
  getLocalAudit,
  getLocalAuditZone,
  listQuestionsWithAnswers,
  pauseLocalAudit,
  saveLocalResponse,
  saveZoneRemark,
  scoreLocalZone,
} from '../../lib/db/audit.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { formatPct } from '../../lib/format';
import { isFinished } from '../../lib/labels';
import { useSync } from '../../lib/sync/provider';
import { bandOf, createThemedStyles, useTheme } from '../../lib/theme';

/** Ten questions to a page: with a five-by-ten checklist, a page is one S. */
const PAGE_SIZE = 10;
/** An answer reaches the server this long after the last tap, so a page of taps is one push. */
const SYNC_DEBOUNCE_MS = 1_500;

/** `postCompletionOverrideRequestSchema`'s floor, so the server never refuses what was typed. */
const MIN_JUSTIFICATION = 10;

type Row = Awaited<ReturnType<typeof listQuestionsWithAnswers>>[number];

/**
 * The questionnaire: ten scrollable questions a page, Previous and Next, and Submit on the
 * last page.
 *
 * **Nothing here awaits the network.** Every tap writes to SQLite first — the answer shows
 * as chosen at once — and a sync follows a moment after the last tap. §9.1 makes the local
 * store the source of truth while an audit is in progress, so an auditor standing in a press
 * shop with no signal still finishes; the answers go out when the radio comes back.
 *
 * The score on the last page is `scoreZone` from `@audit5s/domain`, the same function the
 * server runs on the way in (D5), and it says it is the device's figure.
 */
export default function QuestionnaireScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const { auditZoneId } = useLocalSearchParams<{ auditZoneId: string }>();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { sync } = useSync();
  const list = useRef<FlatList<Row>>(null);

  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<Record<string, ResponseValue>>({});
  const [zoneRemarkDraft, setZoneRemarkDraft] = useState('');
  const [cameraFor, setCameraFor] = useState<Row | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  /**
   * R-30's correction mode, on a finished audit.
   *
   * `null` is the ordinary read-only state. A string — the justification — is the auditor
   * having said why, which is what unlocks the marks. It is deliberately not a boolean:
   * A-2's door does not open without a reason, and holding the reason *as* the unlocked
   * state means there is no path through this screen that corrects a mark without one.
   */
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [reasonDraft, setReasonDraft] = useState('');

  const zone = useQuery({
    queryKey: ['local', 'audit-zone', auditZoneId],
    queryFn: async () => (await getLocalAuditZone(database, auditZoneId))[0] ?? null,
  });

  /**
   * The audit this Zone belongs to, for one question: may the answers still be changed?
   *
   * PART 6 permits a revision until the **audit** is COMPLETED — a finished Zone may be
   * reopened from the Review button and re-answered, and the server rescores when it is.
   * Once the audit itself is finished, A-2 closes it to everyone but a Super Admin, and
   * this screen has to stop offering what the server will refuse.
   */
  const audit = useQuery({
    enabled: Boolean(zone.data?.auditId),
    queryKey: ['local', 'audit', zone.data?.auditId],
    queryFn: async () => (await getLocalAudit(database, zone.data!.auditId))[0] ?? null,
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

  const photos = useQuery({
    queryKey: ['local', 'zone-evidence', auditZoneId],
    queryFn: () => listLocalEvidenceForZone(database, auditZoneId),
  });

  // Resume on the page holding the cursor question (§9.8) — once, on open, so a save that
  // moves the cursor never flips the page under the auditor's thumb.
  const resumed = useRef(false);
  useEffect(() => {
    const rows = questions.data;
    if (resumed.current || !rows) return;
    resumed.current = true;
    const cursor = zone.data?.resumeQuestionId;
    const position = cursor ? rows.findIndex((row) => row.questionId === cursor) : -1;
    if (position >= 0) setPage(Math.floor(position / PAGE_SIZE));
  }, [questions.data, zone.data?.resumeQuestionId]);

  useEffect(() => {
    setZoneRemarkDraft(zone.data?.zoneRemark ?? '');
  }, [zone.data?.zoneRemark]);

  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => void sync(), SYNC_DEBOUNCE_MS);
  }, [sync]);
  useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [],
  );

  const save = useMutation({
    mutationFn: async (input: { row: Row; value: ResponseValue; remark: string | null }) => {
      // SQLite commits before this resolves.
      const responseId = await saveLocalResponse(database, {
        auditZoneId,
        auditId: zone.data!.auditId,
        checklistQuestionId: input.row.questionId,
        section: input.row.section as SSection,
        globalOrder: input.row.globalOrder,
        value: input.value,
        remark: input.remark,
      });

      // E-2, on the device: a photograph already attached to this question is re-filed to
      // match the answer as it now stands. The server does this authoritatively inside its
      // own transaction; doing it here means the count under the question is right *before*
      // the sync.
      await reclassifyLocalEvidence(database, responseId, input.value);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      scheduleSync();
    },
  });

  /**
   * A correction to a finished audit (R-30). It queues an override rather than an answer.
   *
   * A response that has no id on the device has never been to the server, which cannot
   * happen on an audit that completed — but the override addresses changes *by response
   * id*, so the guard is here rather than as an assumption.
   */
  const correct = useMutation({
    mutationFn: async (input: { row: Row; value: ResponseValue; remark: string | null }) => {
      if (!input.row.responseId) {
        throw new Error('This question has no saved answer to correct.');
      }
      await applyLocalOverride(database, {
        auditId: zone.data!.auditId,
        responseId: input.row.responseId,
        value: input.value,
        remark: input.remark,
        justification: correcting ?? '',
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      scheduleSync();
    },
  });

  const finish = useMutation({
    mutationFn: async () => {
      await saveZoneRemark(database, auditZoneId, zoneRemarkDraft.trim() || null);
      await assertZonePhotoLimitForCompletion(database, auditZoneId);
      await completeLocalZone(database, auditZoneId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      // Completion is a high-priority sync trigger (§9.3).
      void sync();
      router.back();
    },
  });

  /**
   * A photograph for one question (§9.4), classified from the answer as it stands — the
   * same `classifyEvidence` the server runs — so it matches what the report will print.
   */
  const capture = useMutation({
    mutationFn: async (image: ProcessedImage) => {
      const row = cameraFor!;
      const responseId = await responseIdFor(database, auditZoneId, row.questionId);
      const location = await readLocation();
      const value = picked[row.questionId] ?? (row.value as ResponseValue | null);

      return captureLocalEvidence(database, {
        auditId: zone.data!.auditId,
        auditZoneId,
        kind: 'QUESTION_EVIDENCE',
        ...(responseId ? { questionResponseId: responseId } : {}),
        scoreAtCapture: value ?? null,
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
    onSuccess: (evidenceId) => {
      // The camera closes the moment SQLite has the photo; the lists refresh behind it.
      setCameraFor(null);
      void queryClient.invalidateQueries({ queryKey: ['local'] });
      // §2.3 step 13: the auditor sees what they took, and may keep, flag or delete it.
      setPreviewId(evidenceId);
      scheduleSync();
    },
  });

  // N7: pausing saves and never discards, and it never waits.
  const pause = useMutation({
    mutationFn: () => pauseLocalAudit(database, zone.data!.auditId, 'Aborted by auditor'),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      router.back();
    },
  });

  const goTo = useCallback((next: number) => {
    setPage(next);
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  // The hardware back button pages back through the questions and never discards (§5).
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (cameraFor) {
        setCameraFor(null);
        return true;
      }
      if (page > 0) {
        goTo(page - 1);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [cameraFor, page, goTo]);

  // The audit joins the wait: until its status is known the screen cannot say whether the
  // answers may be changed, and guessing "yes" for a frame is a tap that queues a write the
  // server will refuse.
  if (zone.isLoading || questions.isLoading || audit.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.ink} />
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

  const title = zoneDisplayLabel(zone.data.zoneCodeSnapshot, zone.data.zoneNameSnapshot);
  const rows = questions.data ?? [];

  if (rows.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ title }} />
        <Muted>This Zone has no checklist pinned to it.</Muted>
      </Screen>
    );
  }

  const valueOf = (row: Row) => picked[row.questionId] ?? (row.value as ResponseValue | null);
  const pageCount = Math.ceil(rows.length / PAGE_SIZE);
  const lastPage = page >= pageCount - 1;
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const answered = rows.filter((row) => valueOf(row) !== null).length;
  const pageAnswered = pageRows.filter((row) => valueOf(row) !== null).length;
  const unanswered = rows.length - answered;
  const section = pageRows[0]?.section as SSection | undefined;
  const zonePhotos = photos.data ?? [];
  const zonePhotoCount = zonePhotos.filter((photo) => isZoneAuditPhoto(photo.kind)).length;
  const photosFor = (row: Row) =>
    row.responseId ? zonePhotos.filter((photo) => photo.questionResponseId === row.responseId) : [];
  const previewPhoto = previewId ? (zonePhotos.find((photo) => photo.id === previewId) ?? null) : null;
  /**
   * Whether anything on this screen may still be changed.
   *
   * It is the **audit's** status, not the Zone's. A finished Zone inside an open audit is
   * exactly the case the Review button exists for, and it was editable all along — what
   * was missing was the server rescoring afterwards, which it now does. A Zone of a
   * finished audit is a different thing: every write to it is refused (A-2), and an app
   * that accepted the tap anyway saved a score into an outbox item the server would throw
   * out. The auditor saw the new number, nobody else ever did, and nothing said so.
   */
  const auditOpen = audit.data
    ? !isFinished(audit.data.status) && audit.data.status !== 'CANCELLED'
    : false;
  /**
   * R-30: a finished audit is correctable by the auditor who conducted it, through A-2's
   * override — and every audit in this device's store is one this device's user conducted
   * (§9.7 ties the database to the signed-in user). A cancelled audit is not: it was
   * voided, and correcting a void is not a thing to offer.
   */
  const correctable = Boolean(audit.data) && audit.data!.status !== 'CANCELLED' && !auditOpen;
  const editable = auditOpen || correcting !== null;
  const reviewingFinishedZone = auditOpen && zone.data.status === 'COMPLETED';

  const submit = () => {
    const firstMissing = rows.findIndex((row) => valueOf(row) === null);
    if (firstMissing >= 0) {
      setShowMissing(true);
      goTo(Math.floor(firstMissing / PAGE_SIZE));
      return;
    }
    finish.mutate();
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          title,
          headerRight: () =>
            auditOpen ? (
              <HeaderAction
                title="Pause"
                accessibilityLabel="Pause the audit. Your answers stay saved on this device."
                onPress={() => pause.mutate()}
              />
            ) : null,
        }}
      />

      {/* Frozen above the questions, so the S and its progress stay in view while scrolling. */}
      <View style={styles.pinned}>
        <SectionHead
          title={section ? S_SECTION_LABELS[section] : 'Questions'}
          description={`Questions ${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + pageRows.length} of ${rows.length || TOTAL_QUESTIONS}`}
        />
        <View
          style={styles.progressRow}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`${pageAnswered} of ${pageRows.length} answered on this page`}
          accessibilityValue={{ min: 0, max: pageRows.length, now: pageAnswered }}
        >
          <Text style={styles.progressLabel}>
            {section ? S_SECTION_SHORT_LABELS[section] : ''} progress
          </Text>
          {/* Answering progress is not a score, so it is ink, never a band colour. */}
          <View style={styles.progressTrack}>
            <View
              style={[styles.progressFill, { width: `${(pageAnswered / pageRows.length) * 100}%` }]}
            />
          </View>
          <Text style={styles.progressCount}>
            {pageAnswered}/{pageRows.length}
          </Text>
        </View>
      </View>

      <FlatList
        ref={list}
        data={pageRows}
        keyExtractor={(row) => row.questionId}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            {/*
              Two states worth naming, and neither used to be named at all. A finished
              audit is read-only and says who can reopen it; a finished Zone in an open
              audit is editable and says what makes the change count.
            */}
            {correcting !== null ? (
              <Slip title="Correcting a finished audit">
                <SlipText>
                  Every mark you change is sent with your reason and written to the audit
                  log, with what it was and what you made it (A-2). The score is recomputed
                  for the dashboard and the report.
                </SlipText>
                <View style={styles.slipAction}>
                  <Button
                    title="Done correcting"
                    variant="secondary"
                    onPress={() => {
                      setCorrecting(null);
                      setReasonDraft('');
                    }}
                  />
                </View>
              </Slip>
            ) : !auditOpen ? (
              <Slip title="This audit is finished">
                <SlipText>
                  The marks below are the record. You may still correct one you got wrong —
                  it is logged with your reason, and nothing is overwritten quietly (A-2).
                </SlipText>
                {correctable ? (
                  <View style={styles.slipAction}>
                    <Field
                      label="Why the correction is needed"
                      multiline
                      placeholder="What was wrong with the mark, in your words"
                      value={reasonDraft}
                      onChangeText={setReasonDraft}
                      hint="At least ten characters. It is written to the audit log."
                    />
                    <Button
                      title="Correct a mark"
                      disabled={reasonDraft.trim().length < MIN_JUSTIFICATION}
                      onPress={() => setCorrecting(reasonDraft.trim())}
                    />
                  </View>
                ) : null}
              </Slip>
            ) : reviewingFinishedZone ? (
              <Slip title="Reviewing a finished Zone">
                <SlipText>
                  Change any answer you need to, then press Submit again. The score is
                  recomputed and the Zone counts as finished once more.
                </SlipText>
              </Slip>
            ) : null}
            <Muted>{zonePhotoCount} / {ZONE_PHOTO_LIMIT} photos in this Zone — shared across all 50 questions.</Muted>
            {auditOpen && zonePhotoCount >= ZONE_PHOTO_LIMIT ? (
              <Card>
                <ErrorBanner message={zonePhotoCount > ZONE_PHOTO_LIMIT
                  ? `This Zone has ${zonePhotoCount} photos. Remove ${zonePhotoCount - ZONE_PHOTO_LIMIT} to meet the 25-photo limit. Remove another to take a new photo.`
                  : ZONE_PHOTO_LIMIT_MESSAGE} />
                <Muted>Tap a photo below, then Delete photo. No photos are removed automatically.</Muted>
                <PhotoThumbs photos={zonePhotos} onOpen={setPreviewId} />
              </Card>
            ) : null}
            <MarkingScheme />
            {showMissing && unanswered > 0 ? (
              <ErrorBanner
                message={`${unanswered} question${unanswered === 1 ? '' : 's'} still need${unanswered === 1 ? 's' : ''} an answer. ${unanswered === 1 ? 'It is' : 'They are'} marked in red.`}
              />
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <QuestionCard
            row={item}
            value={valueOf(item)}
            photos={photosFor(item)}
            onPreview={setPreviewId}
            missing={showMissing && valueOf(item) === null}
            readOnly={!editable}
            canPhoto={auditOpen && photos.isSuccess && zonePhotoCount < ZONE_PHOTO_LIMIT}
            onAnswer={(value, remark) => {
              setPicked((current) => ({ ...current, [item.questionId]: value }));
              // The same tap, two doors: an open audit takes an answer, a finished one
              // takes a logged correction (R-30).
              if (correcting !== null) correct.mutate({ row: item, value, remark });
              else save.mutate({ row: item, value, remark });
            }}
            onRemark={(remark) => {
              const value = valueOf(item);
              if (!value) return;
              if (correcting !== null) correct.mutate({ row: item, value, remark });
              else save.mutate({ row: item, value, remark });
            }}
            onPhoto={() => setCameraFor(item)}
          />
        )}
        ListFooterComponent={
          lastPage ? (
            <View style={styles.footer}>
              <ScoreCard breakdown={score.data} answered={answered} />
              <SummaryPhotosCard photos={zonePhotos} onOpen={setPreviewId} />
              <Card>
                <Field
                  label="Overall remark (optional)"
                  multiline
                  placeholder="Anything the report should carry about this Zone"
                  value={zoneRemarkDraft}
                  onChangeText={setZoneRemarkDraft}
                  containerStyle={styles.lastField}
                />
              </Card>
              <ErrorBanner message={finish.error instanceof Error ? finish.error.message : null} />
            </View>
          ) : (
            <Muted>Answers save on this device as you tap, and sync as soon as there is a connection.</Muted>
          )
        }
      />

      <ActionBar>
        <View style={styles.navRow}>
          <View style={styles.navButton}>
            <Button
              title="Previous"
              variant="secondary"
              disabled={page === 0}
              onPress={() => goTo(page - 1)}
            />
          </View>
          <View style={styles.navButton}>
            {!lastPage ? (
              <Button title="Next" onPress={() => goTo(page + 1)} testID="next-page" />
            ) : auditOpen ? (
              <Button
                // The word changes because the act does: the first pass finishes the Zone,
                // a review commits the revision and rescores it.
                title={reviewingFinishedZone ? 'Save changes' : 'Submit'}
                busy={finish.isPending}
                onPress={submit}
                testID="submit-zone"
              />
            ) : (
              <Button
                title={correcting !== null ? 'Done' : 'Close'}
                variant="secondary"
                onPress={() => router.back()}
              />
            )}
          </View>
        </View>
      </ActionBar>

      <PhotoPreview photo={previewPhoto} editable={auditOpen} onClose={() => setPreviewId(null)} />

      {/* Over the questions, not instead of them. Swapping the list out for the camera
          unmounted it and threw its scroll position away, so coming back from a photograph
          for Q20 landed on Q11, the top of the page. */}
      {cameraFor ? (
        <View style={styles.cameraLayer}>
          <CameraCapture
            beforeCapture={() => assertZonePhotoCapacity(database, auditZoneId)}
            prompt={`Photograph for question ${cameraFor.globalOrder}`}
            onCaptured={async (image) => {
              await capture.mutateAsync(image);
            }}
            onCancel={() => setCameraFor(null)}
          />
        </View>
      ) : null}
    </Screen>
  );
}

/** The four answers, said once at the top of every page instead of under every question. */
function MarkingScheme() {
  const styles = useStyles();
  return (
    <View style={styles.scheme}>
      <Label>Marking scheme</Label>
      <View style={styles.schemeGrid}>
        {(['SCORE_2', 'SCORE_1', 'SCORE_0', 'NA'] as ResponseValue[]).map((value) => {
          const token = RESPONSE_TOKENS[value]!;
          return (
            <View key={value} style={styles.schemeItem}>
              <Text style={styles.schemeMark}>{token.marks === null ? 'NA' : token.marks}</Text>
              <Text style={styles.schemeText}>{token.label}</Text>
            </View>
          );
        })}
      </View>
      <Text style={styles.schemeNote}>
        Every question is compulsory. Use NA only when the checkpoint does not apply here.
      </Text>
    </View>
  );
}

function QuestionCard({
  row,
  value,
  photos,
  onPreview,
  missing,
  readOnly,
  canPhoto,
  onAnswer,
  onRemark,
  onPhoto,
}: {
  row: Row;
  value: ResponseValue | null;
  photos: readonly LocalPhoto[];
  onPreview: (evidenceId: string) => void;
  missing: boolean;
  /** The marks are locked: a finished audit nobody has opened a correction on (A-2). */
  readOnly: boolean;
  /**
   * Whether a photograph may still be taken for this question.
   *
   * Not the same as `!readOnly`, and the difference matters. A correction under R-30
   * changes marks and remarks through the override, which carries neither evidence nor an
   * upload intent — and a completed audit refuses a new `evidence` row anyway. So the
   * camera closes when the audit does, even while the marks are open for correction.
   */
  canPhoto: boolean;
  onAnswer: (value: ResponseValue, remark: string | null) => void;
  onRemark: (remark: string | null) => void;
  onPhoto: () => void;
}) {
  const styles = useStyles();
  const [remark, setRemark] = useState(row.remark ?? '');
  const [remarkOpen, setRemarkOpen] = useState(Boolean(row.remark));

  useEffect(() => setRemark(row.remark ?? ''), [row.remark]);

  return (
    <Card rail={missing ? 'crit' : undefined}>
      <View style={styles.questionHead}>
        <Text style={styles.questionNumber}>Q{row.globalOrder}</Text>
        <Text style={styles.question}>{row.text}</Text>
      </View>
      {row.guidance ? <Muted>{row.guidance}</Muted> : null}

      <View style={styles.responses}>
        <Label>Response / marks</Label>
        <ResponseChips
          value={value}
          allowsNa={row.allowsNa === 1}
          readOnly={readOnly}
          onChange={(next) => onAnswer(next, remark.trim() || null)}
        />
        {missing ? <Text style={styles.missing}>Answer required</Text> : null}
      </View>

      <View style={styles.questionFoot}>
        <Text style={styles.photoCount}>
          {photos.length} photo{photos.length === 1 ? '' : 's'}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setRemarkOpen((open) => !open)}
          style={styles.remarkToggle}
        >
          <Text style={styles.remarkToggleText}>
            {remarkOpen ? 'Hide remark' : remark ? 'Edit remark' : 'Add remark'}
          </Text>
        </Pressable>
        {canPhoto ? (
          <Button
            title="Take photo"
            variant="secondary"
            accessibilityLabel={`Take a photograph for question ${row.globalOrder}`}
            onPress={onPhoto}
          />
        ) : null}
      </View>

      {/* Tap a thumbnail to preview it, flag it for the summary, or delete it. */}
      <PhotoThumbs photos={photos} onOpen={onPreview} />

      {remarkOpen ? (
        <Field
          label="Remark"
          multiline
          editable={!readOnly}
          placeholder="What you saw, in your words"
          value={remark}
          onChangeText={setRemark}
          onBlur={() => onRemark(remark.trim() || null)}
          containerStyle={styles.remark}
        />
      ) : null}
    </Card>
  );
}

/**
 * The live score, from the shared domain function.
 *
 * It is the device's figure, so it says so (AGENTS.md: the device is not authoritative about
 * scores). `null` renders `N/A` rather than `0%` (D4): a Zone whose answered questions are
 * all NA has no percentage, and showing zero would tell the auditor they had failed.
 */
function ScoreCard({
  breakdown,
  answered,
}: {
  breakdown: Awaited<ReturnType<typeof scoreLocalZone>> | undefined;
  answered: number;
}) {
  const styles = useStyles();
  if (!breakdown) return null;
  const { totals } = breakdown;
  const band = bandOf(totals.scorePercentage);

  return (
    <Card>
      <CardHeader
        title="Score so far"
        description="Worked out on this device as a guide. The server recomputes it when the audit syncs."
        action={band === 'none' ? null : <Chip tone={band}>{bandFor(totals.scorePercentage)?.label}</Chip>}
      />
      <View style={styles.scoreRow}>
        <Figure band={band}>{formatPct(totals.scorePercentage)}</Figure>
        <Text style={styles.scoreMeta}>
          {totals.rawScore}/{totals.maxScore} marks{'\n'}
          {answered} answered, {totals.naQuestions} NA
        </Text>
      </View>
      <StatusBand band={band} />
      <View style={styles.rows}>
        <SectionRows
          marks
          rows={breakdown.sections.map((section) => ({
            section: section.section,
            pct: section.scorePercentage,
            raw: section.rawScore,
            max: section.maxScore,
          }))}
        />
      </View>
    </Card>
  );
}

const useStyles = createThemedStyles((theme) => ({
  slipAction: { marginTop: theme.space.sm, gap: theme.space.sm },
  centered: { alignItems: 'center', justifyContent: 'center' },
  list: { paddingTop: theme.space.md, paddingBottom: theme.space.lg },
  // The top counterpart of `ActionBar`: bleeds to the screen edges, ruled off in 2px ink.
  pinned: {
    marginHorizontal: -theme.space.md,
    marginTop: -theme.space.md,
    paddingHorizontal: theme.space.md,
    paddingTop: theme.space.md,
    backgroundColor: theme.color.tile2,
    borderBottomWidth: 2,
    borderBottomColor: theme.color.edge,
  },
  cameraLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  footer: { marginTop: theme.space.sm },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: theme.space.md },
  progressLabel: {
    fontFamily: theme.family.medium,
    fontSize: 11,
    color: theme.color.ink2,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  progressTrack: {
    flex: 1,
    height: 12,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile2,
  },
  progressFill: { height: '100%', backgroundColor: theme.color.ink },
  progressCount: {
    fontFamily: theme.family.monoMedium,
    fontSize: 12.5,
    color: theme.color.ink,
    fontVariant: ['tabular-nums'],
  },
  scheme: {
    backgroundColor: theme.color.tile2,
    borderWidth: 1.5,
    borderColor: theme.color.edge,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: theme.space.md,
  },
  schemeGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 6 },
  schemeItem: { width: '50%', flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 8 },
  schemeMark: {
    width: 24,
    fontFamily: theme.family.black,
    fontSize: 15,
    color: theme.color.ink,
    fontVariant: ['tabular-nums'],
  },
  schemeText: { flex: 1, fontFamily: theme.family.regular, fontSize: 12.5, color: theme.color.ink2 },
  schemeNote: {
    fontFamily: theme.family.regular,
    fontSize: 12.5,
    lineHeight: 18,
    color: theme.color.ink2,
    marginTop: 8,
  },
  questionHead: { flexDirection: 'row', gap: 10, marginBottom: 4 },
  questionNumber: {
    fontFamily: theme.family.monoMedium,
    fontSize: 13,
    lineHeight: 23,
    color: theme.color.ink3,
    fontVariant: ['tabular-nums'],
  },
  question: {
    flex: 1,
    fontFamily: theme.family.medium,
    fontSize: theme.font.panel,
    lineHeight: 23,
    color: theme.color.ink,
  },
  responses: { marginTop: theme.space.md },
  missing: {
    fontFamily: theme.family.medium,
    fontSize: 12.5,
    color: theme.color.crit,
    marginTop: 6,
  },
  questionFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.sm,
    marginTop: theme.space.md,
    paddingTop: theme.space.sm,
    borderTopWidth: 1,
    borderTopColor: theme.color.edgeSoft,
  },
  photoCount: {
    flex: 1,
    fontFamily: theme.family.mono,
    fontSize: 12,
    color: theme.color.ink2,
    fontVariant: ['tabular-nums'],
  },
  remarkToggle: { minHeight: 48, justifyContent: 'center', paddingHorizontal: theme.space.sm },
  remarkToggleText: {
    fontFamily: theme.family.medium,
    fontSize: theme.font.sm,
    color: theme.color.ink,
    textDecorationLine: 'underline',
  },
  remark: { marginTop: theme.space.md, marginBottom: 0 },
  lastField: { marginBottom: 0 },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: theme.space.md,
    marginBottom: 10,
  },
  scoreMeta: {
    fontFamily: theme.family.mono,
    fontSize: 12,
    lineHeight: 17,
    color: theme.color.ink2,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  rows: { marginTop: theme.space.md },
  navRow: { flexDirection: 'row', gap: theme.space.sm },
  navButton: { flex: 1 },
}));
