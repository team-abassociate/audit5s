import { useState } from 'react';
import { Image, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Kaizen, KaizenDetail, KaizenExport, KaizenFields, KaizenPhotoKind, KaizenReviewDecision, KaizenStatus, Page } from '@audit5s/contracts';
import { formatDate, formatRupees } from '@audit5s/domain';
import { KaizenPhotoViewer } from '../../components/kaizen-photo-viewer';
import { Button, Card, CardHeader, ChoiceList, Chip, Data, ErrorBanner, Field, Hatch, Label, Muted, Screen, Slip, SlipText } from '../../components/ui';
import { api, problemMessage } from '../../lib/api';
import { getLocalKaizen, sheetOf } from '../../lib/db/kaizen.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { DECISION_TONE, KAIZEN_STATUS_ICON, KAIZEN_STATUS_TONE, KAIZEN_STRINGS, type KaizenTextField } from '../../lib/kaizen-strings';
import { useLanguage } from '../../lib/language-provider';
import { useSession } from '../../lib/session';
import { createThemedStyles } from '../../lib/theme';

/**
 * One Kaizen, read-only (§4.3 Detail): the sheet top to bottom with before and after side by
 * side, its status and the Coordinator's reasons.
 *
 * Two sources, one screen. A leader's own Kaizen is read from SQLite, so it opens offline;
 * online it is joined by `GET /kaizens/{id}` for the photos' view URLs and the whole review
 * history. A Coordinator's is the server's alone (they record nothing offline, R-24).
 *
 * Below the sheet: *Edit & resubmit* for the author of a Kaizen sent back, the Review section
 * for a Coordinator on a SUBMITTED one (a reason required to send back or reject), and the
 * Kaizen Sheet PDF for anyone online.
 */
interface Photo {
  uri: string | null;
}
interface SheetView {
  id: string;
  kaizenNo: string | null;
  status: KaizenStatus;
  sheet: KaizenFields;
  zone: string;
  authorName: string | null;
  reviewComment: string | null;
  before: Photo | null;
  after: Photo | null;
}

export default function KaizenDetailScreen() {
  const styles = useStyles();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { kaizenId, reviewedNo, reviewedDecision, reviewedAuthor, reviewedLeft } = useLocalSearchParams<{
    kaizenId: string;
    reviewedNo?: string;
    reviewedDecision?: KaizenReviewDecision;
    reviewedAuthor?: string;
    reviewedLeft?: string;
  }>();
  const database = useLocalDatabase();
  const { can } = useSession();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];

  const local = useQuery({ queryKey: ['local', 'kaizen', kaizenId], queryFn: () => getLocalKaizen(database, kaizenId) });
  const online = useQuery({
    queryKey: ['kaizen', kaizenId],
    queryFn: () => api.get<KaizenDetail>(`/kaizens/${encodeURIComponent(kaizenId)}`),
    retry: false,
  });

  const [decision, setDecision] = useState<KaizenReviewDecision | null>(null);
  const [comment, setComment] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [viewing, setViewing] = useState<KaizenPhotoKind | null>(null);
  const review = useMutation({
    mutationFn: () =>
      api.post(`/kaizens/${encodeURIComponent(kaizenId)}/review`, { decision, comment: comment.trim() || null }),
    onSuccess: () => {
      // Say what happened, then move on to the next Kaizen waiting (plan 3.2), read from the
      // queue Overview already holds, before it is invalidated.
      const queue = queryClient.getQueryData<Page<Kaizen>>(['kaizens', 'SUBMITTED'])?.data ?? [];
      const rest = queue.filter((kaizen) => kaizen.id !== kaizenId);
      const said = {
        reviewedNo: view?.kaizenNo ?? '',
        reviewedDecision: decision!,
        reviewedAuthor: view?.authorName ?? '',
      };
      void queryClient.invalidateQueries({ queryKey: ['kaizen', kaizenId] });
      void queryClient.invalidateQueries({ queryKey: ['kaizens'] });
      void queryClient.invalidateQueries({ queryKey: ['kaizen-dashboard'] });
      if (rest[0]) {
        router.replace({
          pathname: '/kaizen/[kaizenId]',
          params: { kaizenId: rest[0].id, ...said, reviewedLeft: String(rest.length) },
        });
      } else {
        router.navigate({ pathname: '/kaizen/overview', params: said });
      }
    },
  });

  // §4.6: queued, then polled until READY; the file opens from its short-lived URL.
  const exportPdf = useMutation({
    mutationFn: async () => {
      const path = `/kaizens/${encodeURIComponent(kaizenId)}/export`;
      let job = await api.post<KaizenExport>(path);
      for (let tries = 0; job.status === 'QUEUED' && tries < 60; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        job = await api.get<KaizenExport>(`${path}/${job.exportId}`);
      }
      if (job.status !== 'READY' || !job.downloadUrl) throw new Error(t.exportFailed);
      await Linking.openURL(job.downloadUrl);
    },
  });

  const view = sheetView(local.data ?? null, online.data ?? null);
  if (local.isLoading || (!view && online.isLoading)) return null;
  if (!view) {
    return (
      <Screen>
        <Muted>{online.isError ? t.kaizenNeedsConnection : t.notOnPhone}</Muted>
      </Screen>
    );
  }

  const sheet = view.sheet;
  const row = (field: KaizenTextField, value: string | null | undefined) =>
    value ? (
      <View key={field} style={styles.row}>
        <Label>{t.field[field]}</Label>
        <Text style={styles.value}>{value}</Text>
      </View>
    ) : null;
  const listRow = (label: string, value: string | null) =>
    value ? (
      <View key={label} style={styles.row}>
        <Label>{label}</Label>
        <Text style={styles.value}>{value}</Text>
      </View>
    ) : null;
  const reviews = online.data?.reviews.filter((entry) => entry.comment) ?? [];
  const reviewing = can('kaizen', 'review') && view.status === 'SUBMITTED' && online.data !== undefined;
  const needsReason = decision === 'SENT_BACK' || decision === 'REJECTED';

  return (
    <Screen>
      <Stack.Screen options={{ title: view.kaizenNo ?? t.numberOnSync }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {reviewedNo && reviewedDecision ? (
          <Slip title={t.reviewed(reviewedDecision, reviewedNo, reviewedAuthor ?? '')}>
            <SlipText>{t.moreWaiting(Number(reviewedLeft ?? 0))}</SlipText>
          </Slip>
        ) : view.status === 'SENT_BACK' || view.status === 'REJECTED' ? (
          <Slip title={`${t.status[view.status]} · ${t.coordinator}`}>
            {reviews.length
              ? reviews.map((entry) => (
                  <SlipText key={entry.id}>
                    {formatDate(entry.createdAt)}: {entry.comment}
                  </SlipText>
                ))
              : view.reviewComment ? <SlipText>{view.reviewComment}</SlipText> : null}
          </Slip>
        ) : null}

        {local.data && (view.status === 'SENT_BACK' || view.status === 'DRAFT') ? (
          <Button
            testID="kaizen-edit"
            title={view.status === 'SENT_BACK' ? t.editResubmit : t.continueDraft}
            icon="edit"
            onPress={() => router.push({ pathname: '/kaizen/edit/[kaizenId]', params: { kaizenId: view.id } })}
          />
        ) : null}

        <Card>
          <View style={styles.head}>
            <Chip tone={KAIZEN_STATUS_TONE[view.status]} icon={KAIZEN_STATUS_ICON[view.status]}>{t.status[view.status]}</Chip>
            <Data>{view.zone}</Data>
          </View>
          <Text style={styles.theme}>{sheet.theme || '—'}</Text>
          {view.authorName ? <Muted>{t.by(view.authorName)}</Muted> : null}

          <View style={styles.pair}>
            <PhotoBox label={t.before} open={t.openPhoto('BEFORE')} none={t.none} photo={view.before} onOpen={() => setViewing('BEFORE')} />
            <PhotoBox label={t.after} open={t.openPhoto('AFTER')} none={t.none} photo={view.after} onOpen={() => setViewing('AFTER')} />
          </View>

          {row('machine', [sheet.machine, sheet.lineArea].filter(Boolean).join(' · '))}
          {row('implementedOn', sheet.implementedOn ? formatDate(sheet.implementedOn) : null)}
          {row('teamMembers', sheet.teamMembers)}
          {row('target', sheet.target)}
          {row('problem5w1h', sheet.problem5w1h)}
          {row('rootCause4m', sheet.rootCause4m)}
          {row('analysis7qc', sheet.analysis7qc)}
          {row('countermeasure', sheet.countermeasure)}
          {listRow(t.step.wastes, sheet.wastes?.length ? sheet.wastes.map((waste) => t.waste[waste]).join(', ') : null)}
          {listRow(t.step.parameters, sheet.parameters?.length ? sheet.parameters.map((p) => t.parameter[p]).join(', ') : null)}
          {listRow(
            t.step.horizontal,
            sheet.horizontalDeployment === null || sheet.horizontalDeployment === undefined ? null : sheet.horizontalDeployment ? t.yes : t.no,
          )}
          {row('benefits', sheet.benefits)}
          {row('annualSaving', sheet.annualSaving ? formatRupees(sheet.annualSaving) : null)}
          {row('ideaBy', sheet.ideaBy)}
          {row('implementedBy', sheet.implementedBy)}
        </Card>

        {reviewing ? (
          <Card>
            <CardHeader title={t.reviewTitle} />
            {/* A choice, then one button named for what it does (S6): Reject never looks like Approve. */}
            <ChoiceList<KaizenReviewDecision>
              options={(['APPROVED', 'SENT_BACK', 'REJECTED'] as const).map((choice) => ({
                value: choice,
                label: t.decision[choice],
                tone: DECISION_TONE[choice],
                icon: KAIZEN_STATUS_ICON[choice],
              }))}
              value={decision}
              onChange={(choice) => {
                setDecision(choice);
                setReasonMissing(false);
              }}
            />
            {decision ? (
              <>
                <Field
                  testID="kaizen-review-comment"
                  label={needsReason ? t.reason : t.comment}
                  value={comment}
                  onChangeText={setComment}
                  multiline
                  {...(reasonMissing ? { error: t.reasonRequired } : {})}
                />
                <ErrorBanner message={problemMessage(review.error)} />
                <Button
                  testID="kaizen-review-confirm"
                  title={t.confirm[decision]}
                  tone={DECISION_TONE[decision]}
                  icon={KAIZEN_STATUS_ICON[decision]}
                  busy={review.isPending}
                  onPress={() => {
                    if (needsReason && !comment.trim()) setReasonMissing(true);
                    else review.mutate();
                  }}
                />
              </>
            ) : null}
          </Card>
        ) : null}

        {online.data && view.status !== 'DRAFT' ? (
          <>
            <ErrorBanner message={exportPdf.error ? (problemMessage(exportPdf.error) ?? t.exportFailed) : null} />
            <Button
              testID="kaizen-export"
              title={exportPdf.isPending ? t.exporting : t.exportPdf}
              variant="secondary"
              icon="file-download"
              busy={exportPdf.isPending}
              onPress={() => exportPdf.mutate()}
            />
          </>
        ) : null}
      </ScrollView>
      <KaizenPhotoViewer
        photos={{ BEFORE: photoUri(view.before), AFTER: photoUri(view.after) }}
        kind={viewing}
        onClose={() => setViewing(null)}
      />
    </Screen>
  );
}

/** The phone's copy wins for what the leader wrote; the server's adds what only it has. */
function sheetView(local: Awaited<ReturnType<typeof getLocalKaizen>>, online: KaizenDetail | null): SheetView | null {
  if (local) {
    const photo = (mine: typeof local.before, url: string | null | undefined): Photo | null =>
      mine ? { uri: mine.localFileUri ?? url ?? null } : null;
    return {
      id: local.id,
      kaizenNo: local.kaizenNo,
      status: local.status,
      sheet: local.sheet,
      zone: `${local.zoneCode} · ${local.zoneName}`,
      authorName: null,
      reviewComment: local.reviewComment,
      before: photo(local.before, online?.beforePhoto?.viewUrl),
      after: photo(local.after, online?.afterPhoto?.viewUrl),
    };
  }
  if (!online) return null;
  return {
    id: online.id,
    kaizenNo: online.kaizenNo,
    status: online.status,
    sheet: sheetOf(online),
    zone: `${online.zoneCode} · ${online.zoneName}`,
    authorName: online.authorName,
    reviewComment: online.latestReview?.comment ?? null,
    before: online.beforePhoto ? { uri: online.beforePhoto.viewUrl } : null,
    after: online.afterPhoto ? { uri: online.afterPhoto.viewUrl } : null,
  };
}

/** For the viewer: the address, `undefined` while only the server has it, `null` for none. */
function photoUri(photo: Photo | null): string | null | undefined {
  return photo ? (photo.uri ?? undefined) : null;
}

/**
 * One of the pair: the photo, a plain ground while it is only on the server, or the hatch.
 * A photo opens full screen (plan 3.1); "none" has nothing to open.
 */
function PhotoBox({ label, open, none, photo, onOpen }: { label: string; open: string; none: string; photo: Photo | null; onOpen: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.photoBox}>
      <Label>{photo ? label : `${label} · ${none}`}</Label>
      <Pressable
        disabled={!photo}
        accessibilityRole="imagebutton"
        accessibilityLabel={open}
        onPress={onOpen}
        style={({ pressed }) => [styles.photo, pressed && styles.photoPressed]}
      >
        {photo?.uri ? <Image source={{ uri: photo.uri }} style={styles.image} /> : photo ? null : <Hatch />}
      </Pressable>
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.xl, gap: theme.space.md },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.sm, marginBottom: theme.space.sm },
  theme: { fontFamily: theme.family.bold, fontSize: theme.font.heading, lineHeight: 24, color: theme.color.ink, marginBottom: theme.space.xs },
  pair: { flexDirection: 'row', gap: theme.space.sm, marginVertical: theme.space.md },
  photoBox: { flex: 1 },
  photo: { aspectRatio: 1, borderWidth: 1.5, borderColor: theme.color.edge, backgroundColor: theme.color.tile2, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  photoPressed: { borderColor: theme.color.ink, opacity: 0.85 },
  row: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.color.edgeSoft },
  value: { fontFamily: theme.family.regular, fontSize: theme.font.base, lineHeight: 22, color: theme.color.ink },
}));
