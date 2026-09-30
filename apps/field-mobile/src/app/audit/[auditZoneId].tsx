import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, Pressable, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { HeaderBackButton } from 'expo-router/react-navigation';
import {
  OVERALL_ACTION_SUGGESTION_LIMIT,
  OVERALL_ACTION_SUGGESTION_MAX_LENGTH,
  type ResponseValue,
  type SSection,
} from '@audit5s/contracts';
import {
  RESPONSE_TOKENS,
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
  Label,
  Muted,
  NoticeDialog,
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
import { useAbortMenu } from '../../components/abort-menu';
import {
  assertZonePhotoCapacity,
  assertZonePhotoLimitForCompletion,
  captureLocalEvidence,
  listLocalEvidenceForZone,
  reclassifyLocalEvidence,
  responseIdFor,
} from '../../lib/db/evidence.repository';
import { ZONE_PHOTO_LIMIT, isZoneAuditPhoto } from '../../lib/db/photo-limit';
import type { ProcessedImage } from '../../lib/capture/media';
import {
  applyLocalOverride,
  completeLocalZone,
  getLocalAudit,
  getLocalAuditZone,
  getZoneSuggestions,
  listQuestionsWithAnswers,
  saveLocalResponse,
  saveZoneRemark,
  scoreLocalZone,
} from '../../lib/db/audit.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { formatPct } from '../../lib/format';
import { questionWording } from '../../lib/language';
import { useLanguage } from '../../lib/language-provider';
import { isFinished } from '../../lib/labels';
import { useSync } from '../../lib/sync/provider';
import { bandOf, createThemedStyles, useTheme } from '../../lib/theme';
import { leaveScreen } from '../../lib/leave-screen';
import { useRequiredFields } from '../../lib/required-fields';

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
  const { strings: t } = useLanguage();
  const list = useRef<FlatList<Row>>(null);

  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<Record<string, ResponseValue>>({});
  const [zoneRemarkDraft, setZoneRemarkDraft] = useState('');
  /** R-38: the overall corrective-action suggestions, saved with the remark on Finish. */
  const [suggestionDrafts, setSuggestionDrafts] = useState<string[]>([]);
  const [cameraFor, setCameraFor] = useState<Row | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  /** The Q numbers the unanswered-questions stop is naming, or null when it is closed. */
  const [blockedOn, setBlockedOn] = useState<number[] | null>(null);
  /** A question to bring into view once its page has rendered — the first one left blank. */
  const [scrollTo, setScrollTo] = useState<string | null>(null);
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
  // The reason box sits at the top of the list; focusing it is enough to bring it into view.
  const required = useRequiredFields<'reason'>();

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

  const savedSuggestions = useQuery({
    queryKey: ['local', 'zone-suggestions', auditZoneId],
    queryFn: () => getZoneSuggestions(database, auditZoneId),
  });
  useEffect(() => {
    if (savedSuggestions.data) setSuggestionDrafts(savedSuggestions.data);
  }, [savedSuggestions.data]);

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
        throw new Error(t.noAnswerToCorrect);
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
      // None of the suggestions is required: an empty list completes like any other (R-38).
      await saveZoneRemark(
        database,
        auditZoneId,
        zoneRemarkDraft.trim() || null,
        undefined,
        suggestionDrafts,
      );
      await assertZonePhotoLimitForCompletion(database, auditZoneId);
      await completeLocalZone(database, auditZoneId);
    },
    onSuccess: () => {
      leaveScreen(
        // Always to the audit's Zones, to add the next one — not `back()`, which from a Zone
        // resumed on Overview lands on Overview, since the Zones screen was never opened.
        () => router.dismissTo({ pathname: '/audit/zones/[auditId]', params: { auditId: zone.data!.auditId } }),
        () => {
          void queryClient.invalidateQueries({ queryKey: ['local'] });
          // Completion is a high-priority sync trigger (§9.3).
          void sync();
        },
      );
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

  // Before any early return: it is a hook. The labels settle once the Zone has loaded.
  const abortMenu = useAbortMenu({
    auditId: zone.data?.auditId,
    auditZoneId,
    zoneLabel: zone.data
      ? zoneDisplayLabel(zone.data.zoneCodeSnapshot, zone.data.zoneNameSnapshot)
      : 'this Zone',
    zoneFinished: zone.data?.status === 'COMPLETED',
  });

  // Runs after the page holding the question has rendered, so the index is on this page.
  useEffect(() => {
    const rows = questions.data;
    if (!scrollTo || !rows) return;
    const index = rows
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .findIndex((row) => row.questionId === scrollTo);
    setScrollTo(null);
    if (index < 0) return;
    requestAnimationFrame(() =>
      list.current?.scrollToIndex({ index, animated: true, viewPosition: 0, viewOffset: 8 }),
    );
  }, [scrollTo, page, questions.data]);

  const goTo = useCallback((next: number) => {
    setPage(next);
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  // Android's back gesture follows the header back action; Previous still changes pages.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (cameraFor) {
        setCameraFor(null);
        return true;
      }
      if (audit.data?.status === 'IN_PROGRESS') {
        abortMenu.pauseAudit();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [cameraFor, audit.data?.status, abortMenu.pauseAudit]);

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
        <Muted>{t.notOnDevice}</Muted>
      </Screen>
    );
  }

  const title = zoneDisplayLabel(zone.data.zoneCodeSnapshot, zone.data.zoneNameSnapshot);
  const rows = questions.data ?? [];

  if (rows.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ title }} />
        <Muted>{t.noChecklist}</Muted>
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
  // A withdrawn Zone left the audit: it reads as it was left and takes no more answers.
  const auditOpen = audit.data
    ? !isFinished(audit.data.status) &&
      audit.data.status !== 'CANCELLED' &&
      zone.data.status !== 'WITHDRAWN'
    : false;
  /**
   * R-30: a finished audit is correctable by the auditor who conducted it, through A-2's
   * override — and every audit in this device's store is one this device's user conducted
   * (§9.7 ties the database to the signed-in user). A cancelled audit is not: it was
   * voided, and correcting a void is not a thing to offer.
   */
  const correctable = Boolean(audit.data) && audit.data!.status !== 'CANCELLED' && !auditOpen;
  const editable = auditOpen || correcting !== null;
  const reasonGiven = reasonDraft.trim().length >= MIN_JUSTIFICATION;
  const reviewingFinishedZone = auditOpen && zone.data.status === 'COMPLETED';

  /**
   * The stop between one S and the next: every question on this page is answered before the
   * auditor may leave it forwards. Hunting for the one skipped question across fifty at the
   * end cost more time than answering it while standing in front of it.
   *
   * Only while answers can be given — a finished audit's pages are read, not filled in.
   */
  const next = () => {
    const missing = auditOpen ? pageRows.filter((row) => valueOf(row) === null) : [];
    if (missing.length > 0) {
      setShowMissing(true);
      setBlockedOn(missing.map((row) => row.globalOrder));
      setScrollTo(missing[0]!.questionId);
      return;
    }
    goTo(page + 1);
  };

  const submit = () => {
    const missing = rows.filter((row) => valueOf(row) === null);
    if (missing.length > 0) {
      setShowMissing(true);
      setBlockedOn(missing.map((row) => row.globalOrder));
      const firstPage = Math.floor(rows.indexOf(missing[0]!) / PAGE_SIZE);
      if (firstPage !== page) goTo(firstPage);
      setScrollTo(missing[0]!.questionId);
      return;
    }
    finish.mutate();
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          title,
          // "Abort" — withdraw this Zone, or pause the whole audit — within a thumb of the
          // questions, not only from the Zones list behind them.
          headerLeft:
            audit.data?.status === 'IN_PROGRESS'
              ? ({ tintColor }) => (
                  <HeaderBackButton
                    tintColor={tintColor}
                    accessibilityLabel={t.pauseAudit}
                    disabled={abortMenu.busy}
                    // Over the camera, back closes the camera and returns to the question —
                    // the same as Android's back gesture. Only from the questions does it
                    // pause the audit.
                    onPress={() => (cameraFor ? setCameraFor(null) : abortMenu.pauseAudit())}
                  />
                )
              : undefined,
          headerRight: () => (auditOpen ? abortMenu.trigger : null),
        }}
      />
      {abortMenu.sheet}

      {/* Frozen above the questions, so the S and its progress stay in view while scrolling. */}
      <View style={styles.pinned}>
        <SectionHead
          title={section ? t.sectionTitle[section] : t.questions}
          description={t.questionRange(
            page * PAGE_SIZE + 1,
            page * PAGE_SIZE + pageRows.length,
            rows.length || TOTAL_QUESTIONS,
          )}
        />
        <View
          style={styles.progressRow}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t.answeredOnPage(pageAnswered, pageRows.length)}
          accessibilityValue={{ min: 0, max: pageRows.length, now: pageAnswered }}
        >
          <Text style={styles.progressLabel}>
            {t.progress(section ? S_SECTION_SHORT_LABELS[section] : '')}
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
        // A question below the rendered window has no measured frame yet: land near it by
        // the average height, then aim again once it has rendered.
        onScrollToIndexFailed={(info) => {
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(
            () => list.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0, viewOffset: 8 }),
            100,
          );
        }}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View>
            {/*
              Two states worth naming, and neither used to be named at all. A finished
              audit is read-only and says who can reopen it; a finished Zone in an open
              audit is editable and says what makes the change count.
            */}
            {correcting !== null ? (
              <Slip title={t.correctingTitle}>
                <SlipText>{t.correctingBody}</SlipText>
                <View style={styles.slipAction}>
                  <Button
                    title={t.doneCorrecting}
                    variant="secondary"
                    onPress={() => {
                      setCorrecting(null);
                      setReasonDraft('');
                    }}
                  />
                </View>
              </Slip>
            ) : !auditOpen ? (
              <Slip title={t.finishedTitle}>
                <SlipText>{t.finishedBody}</SlipText>
                {correctable ? (
                  <View style={styles.slipAction}>
                    <Field
                      label={t.reasonLabel}
                      inputRef={required.input('reason')}
                      error={required.error('reason', t.reasonHint, reasonGiven)}
                      multiline
                      placeholder={t.reasonPlaceholder}
                      value={reasonDraft}
                      onChangeText={setReasonDraft}
                      hint={t.reasonHint}
                    />
                    <Button
                      title={t.correctMark}
                      onPress={() =>
                        required.check([['reason', reasonGiven]]) && setCorrecting(reasonDraft.trim())
                      }
                    />
                  </View>
                ) : null}
              </Slip>
            ) : reviewingFinishedZone ? (
              <Slip title={t.reviewingTitle}>
                <SlipText>{t.reviewingBody}</SlipText>
              </Slip>
            ) : null}
            <Muted>{t.zonePhotos(zonePhotoCount, ZONE_PHOTO_LIMIT)}</Muted>
            {auditOpen && zonePhotoCount >= ZONE_PHOTO_LIMIT ? (
              <Card>
                <ErrorBanner message={zonePhotoCount > ZONE_PHOTO_LIMIT
                  ? t.tooManyPhotos(zonePhotoCount, ZONE_PHOTO_LIMIT)
                  : t.photoLimitReached(ZONE_PHOTO_LIMIT)} />
                <Muted>{t.deletePhotoHint}</Muted>
                <PhotoThumbs photos={zonePhotos} onOpen={setPreviewId} />
              </Card>
            ) : null}
            <MarkingScheme />
            {showMissing && unanswered > 0 ? (
              <ErrorBanner
                message={t.unanswered(unanswered)}
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
                  label={t.overallRemark}
                  multiline
                  placeholder={t.overallRemarkPlaceholder}
                  value={zoneRemarkDraft}
                  onChangeText={setZoneRemarkDraft}
                  containerStyle={styles.lastField}
                />
              </Card>
              <Card>
                <CardHeader title={t.overallActions} description={t.overallActionsHint} />
                {suggestionDrafts.map((text, index) => (
                  <View key={index} style={styles.suggestion}>
                    <Field
                      label={`${index + 1}.`}
                      multiline
                      placeholder={t.overallActionPlaceholder}
                      value={text}
                      maxLength={OVERALL_ACTION_SUGGESTION_MAX_LENGTH}
                      onChangeText={(next) =>
                        setSuggestionDrafts((drafts) =>
                          drafts.map((draft, at) => (at === index ? next : draft)),
                        )
                      }
                      containerStyle={styles.lastField}
                    />
                    <Button
                      title={t.removeOverallAction}
                      variant="secondary"
                      onPress={() =>
                        setSuggestionDrafts((drafts) => drafts.filter((_, at) => at !== index))
                      }
                    />
                  </View>
                ))}
                {suggestionDrafts.length < OVERALL_ACTION_SUGGESTION_LIMIT ? (
                  <Button
                    title={t.addOverallAction}
                    variant="secondary"
                    onPress={() => setSuggestionDrafts((drafts) => [...drafts, ''])}
                  />
                ) : null}
              </Card>
              <ErrorBanner message={finish.error instanceof Error ? finish.error.message : null} />
            </View>
          ) : (
            <Muted>{t.savesOffline}</Muted>
          )
        }
      />

      <ActionBar>
        <View style={styles.navRow}>
          <View style={styles.navButton}>
            <Button
              title={t.previous}
              variant="secondary"
              disabled={page === 0}
              onPress={() => goTo(page - 1)}
            />
          </View>
          <View style={styles.navButton}>
            {!lastPage ? (
              <Button title={t.next} onPress={next} testID="next-page" />
            ) : auditOpen ? (
              <Button
                // The word changes because the act does: the first pass finishes the Zone,
                // a review commits the revision and rescores it.
                title={reviewingFinishedZone ? t.saveChanges : t.submit}
                busy={finish.isPending}
                onPress={submit}
                testID="submit-zone"
              />
            ) : (
              <Button
                title={correcting !== null ? t.done : t.close}
                variant="secondary"
                onPress={() => router.back()}
              />
            )}
          </View>
        </View>
      </ActionBar>

      <NoticeDialog
        visible={blockedOn !== null}
        title={t.unansweredTitle}
        message={blockedOn ? t.unansweredGate(blockedOn) : ''}
        actionLabel={t.ok}
        onClose={() => setBlockedOn(null)}
      />

      <PhotoPreview photo={previewPhoto} editable={auditOpen} onClose={() => setPreviewId(null)} />

      {/* Over the questions, not instead of them. Swapping the list out for the camera
          unmounted it and threw its scroll position away, so coming back from a photograph
          for Q20 landed on Q11, the top of the page. */}
      {cameraFor ? (
        <View style={styles.cameraLayer}>
          <CameraCapture
            beforeCapture={() => assertZonePhotoCapacity(database, auditZoneId)}
            prompt={t.cameraPrompt(cameraFor.globalOrder)}
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
  const { strings: t } = useLanguage();
  return (
    <View style={styles.scheme}>
      <Label>{t.markingScheme}</Label>
      <View style={styles.schemeGrid}>
        {(['SCORE_2', 'SCORE_1', 'SCORE_0', 'NA'] as ResponseValue[]).map((value) => {
          const token = RESPONSE_TOKENS[value]!;
          return (
            <View key={value} style={styles.schemeItem}>
              <Text style={styles.schemeMark} numberOfLines={1}>{token.marks === null ? 'NA' : token.marks}</Text>
              <Text style={styles.schemeText}>{t.response[value]}</Text>
            </View>
          );
        })}
      </View>
      <Text style={styles.schemeNote}>{t.schemeNote}</Text>
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
  const { language, strings: t } = useLanguage();
  const wording = questionWording(row, language);
  const [remark, setRemark] = useState(row.remark ?? '');
  const [remarkOpen, setRemarkOpen] = useState(Boolean(row.remark));

  useEffect(() => setRemark(row.remark ?? ''), [row.remark]);

  return (
    <Card rail={missing ? 'crit' : undefined}>
      <View style={styles.questionHead}>
        <Text style={styles.questionNumber}>Q{row.globalOrder}</Text>
        <View style={styles.questionText}>
          <Text style={styles.question}>{wording.text}</Text>
          {/* The English is the record the report prints, so a translation never hides it. */}
          {wording.english ? <Text style={styles.questionEnglish}>{wording.english}</Text> : null}
        </View>
      </View>
      {row.guidance ? <Muted>{row.guidance}</Muted> : null}

      <View style={styles.responses}>
        <Label>{t.responseMarks}</Label>
        <ResponseChips
          value={value}
          allowsNa={row.allowsNa === 1}
          readOnly={readOnly}
          onChange={(next) => onAnswer(next, remark.trim() || null)}
        />
        {missing ? <Text style={styles.missing}>{t.answerRequired}</Text> : null}
      </View>

      <View style={styles.questionFoot}>
        <Text style={styles.photoCount}>
          {t.photoCount(photos.length)}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setRemarkOpen((open) => !open)}
          style={styles.remarkToggle}
        >
          <Text style={styles.remarkToggleText}>
            {remarkOpen ? t.hideRemark : remark ? t.editRemark : t.addRemark}
          </Text>
        </Pressable>
        {canPhoto ? (
          <Button
            title={t.takePhoto}
            variant="secondary"
            accessibilityLabel={t.takePhotoFor(row.globalOrder)}
            onPress={onPhoto}
          />
        ) : null}
      </View>

      {/* Tap a thumbnail to preview it, flag it for the summary, or delete it. */}
      <PhotoThumbs photos={photos} onOpen={onPreview} />

      {remarkOpen ? (
        <Field
          label={t.remark}
          multiline
          editable={!readOnly}
          placeholder={t.remarkPlaceholder}
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
  const { strings: t } = useLanguage();
  if (!breakdown) return null;
  const { totals } = breakdown;
  const band = bandOf(totals.scorePercentage);
  const rating = bandFor(totals.scorePercentage);

  return (
    <Card>
      <CardHeader
        title={t.scoreSoFar}
        description={t.scoreNote}
        action={band === 'none' || !rating ? null : <Chip tone={band}>{t.band[rating.token]}</Chip>}
      />
      <View style={styles.scoreRow}>
        <Figure band={band}>{formatPct(totals.scorePercentage)}</Figure>
        <Text style={styles.scoreMeta}>
          {t.marksLine(totals.rawScore, totals.maxScore, answered, totals.naQuestions)}
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
    // Wide enough for "NA" in Archivo Black on one line; at 24 it broke N over A.
    width: 34,
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
  questionText: { flex: 1 },
  question: {
    fontFamily: theme.family.medium,
    fontSize: theme.font.panel,
    lineHeight: 23,
    color: theme.color.ink,
  },
  questionEnglish: {
    fontFamily: theme.family.regular,
    fontSize: 12.5,
    lineHeight: 18,
    color: theme.color.ink2,
    marginTop: 4,
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
  suggestion: {
    gap: theme.space.sm,
    marginBottom: theme.space.md,
    paddingBottom: theme.space.md,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.edgeSoft,
  },
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
