import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { Kaizen, KaizenDashboard, KaizenDashboardPeriod, KaizenReviewDecision, Page } from '@audit5s/contracts';
import { KaizenCard, cardFromServer, kaizenHref } from '../../../components/kaizen-card';
import { KpiCard } from '../../../components/kaizen-charts';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Figure,
  Label,
  Muted,
  Screen,
  SectionHead,
  Slip,
  SlipText,
  StatusBand,
} from '../../../components/ui';
import { api } from '../../../lib/api';
import { listLocalKaizens, type LocalKaizen } from '../../../lib/db/kaizen.repository';
import { useLocalDatabase } from '../../../lib/db/provider';
import { groupLeaderKaizens } from '../../../lib/kaizen-overview';
import { KAIZEN_STRINGS } from '../../../lib/kaizen-strings';
import { useLanguage } from '../../../lib/language-provider';
import { useSession } from '../../../lib/session';
import { useSync } from '../../../lib/sync/provider';
import { createThemedStyles, type Band } from '../../../lib/theme';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** What the detail passes on after a review (plan 3.2), cleared once it has been read. */
const CLEAR_REVIEWED = { reviewedNo: undefined, reviewedDecision: undefined, reviewedAuthor: undefined };
const CLEAR_SUBMITTED = { submitted: undefined, resubmitted: undefined };

/**
 * Kaizen Overview. A Zone Leader's (§4.3): their own counts for the last 30 days, then
 * what needs them (sent back or rejected, drafts), what waits on the Coordinator, and what
 * was approved. All from SQLite, so it reads the same offline. Pull down to sync.
 *
 * A Coordinator's (and anyone else who reads Kaizens) is live from the API: the KPI card,
 * one yellow slip only when a review is waiting, the queue, then Top 3 approved by saving.
 */
export default function KaizenOverview() {
  const { can } = useSession();
  return can('kaizen', 'create') ? <LeaderOverview /> : <CoordinatorOverview />;
}

function CoordinatorOverview() {
  const styles = useStyles();
  const router = useRouter();
  const { can } = useSession();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const [period, setPeriod] = useState<KaizenDashboardPeriod>('overall');
  // Set by the detail when the last review in the queue is done (plan 3.2).
  const reviewed = useLocalSearchParams<{ reviewedNo?: string; reviewedDecision?: KaizenReviewDecision; reviewedAuthor?: string }>();
  const clearReviewed = useClearParams(Boolean(reviewed.reviewedNo), CLEAR_REVIEWED);
  // Fixed when the screen opens, so the query key does not change on every render.
  const [since] = useState(() => new Date(Date.now() - THIRTY_DAYS_MS).toISOString());

  const dashboard = useQuery({
    queryKey: ['kaizen-dashboard', period],
    queryFn: () => api.get<KaizenDashboard>(`/kaizens/dashboard?period=${period}`),
    placeholderData: (previous) => previous,
  });
  // The queue is every Kaizen awaiting review, whatever the KPI card's period.
  const queue = useQuery({
    queryKey: ['kaizens', 'SUBMITTED'],
    queryFn: () => api.get<Page<Kaizen>>('/kaizens?limit=50&status=SUBMITTED'),
  });
  const top = useQuery({
    queryKey: ['kaizens', 'top3', since],
    queryFn: () =>
      api.get<Page<Kaizen>>(`/kaizens?limit=3&status=APPROVED&sort=saving&submittedFrom=${encodeURIComponent(since)}`),
  });
  const queries = [dashboard, queue, top];
  const waiting = queue.data?.data ?? [];
  const open = (kaizen: Kaizen) => router.push({ pathname: '/kaizen/[kaizenId]', params: { kaizenId: kaizen.id } });
  const cards = (items: readonly Kaizen[]) =>
    items.map((kaizen) => (
      <KaizenCard key={kaizen.id} kaizen={cardFromServer(kaizen)} author={`${kaizen.authorName} · ${kaizen.zoneCode}`} onPress={() => open(kaizen)} />
    ));

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={queries.some((query) => query.isRefetching)}
            onRefresh={() => {
              clearReviewed();
              queries.forEach((query) => void query.refetch());
            }}
          />
        }
      >
        <ErrorBanner message={queries.some((query) => query.isError) ? t.needsConnection : null} />
        {dashboard.data ? <KpiCard kpi={dashboard.data.kpi} period={period} onPeriod={setPeriod} /> : null}
        {/* The one slip: what a review just did, or else that a review waits on this person. */}
        {reviewed.reviewedNo && reviewed.reviewedDecision ? (
          <Slip arriving title={t.reviewed(reviewed.reviewedDecision, reviewed.reviewedNo, reviewed.reviewedAuthor ?? '')}>
            <SlipText>{t.moreWaiting(waiting.length)}</SlipText>
          </Slip>
        ) : can('kaizen', 'review') && waiting.length > 0 ? (
          <Slip accessibilityRole="button" title={t.reviewWaiting(waiting.length)} onPress={() => open(waiting[0]!)} />
        ) : null}

        <SectionHead title={t.awaitingSection} />
        {queue.data ? (waiting.length ? cards(waiting) : <EmptyState title={t.queueEmpty} />) : null}

        <SectionHead title={t.top3Section} />
        {top.data ? (top.data.data.length ? cards(top.data.data) : <EmptyState title={t.top3Empty} />) : null}
      </ScrollView>
    </Screen>
  );
}

function LeaderOverview() {
  const styles = useStyles();
  const router = useRouter();
  const database = useLocalDatabase();
  const { sync, syncing } = useSync();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const { submitted, resubmitted } = useLocalSearchParams<{ submitted?: string; resubmitted?: string }>();
  const kaizens = useQuery({ queryKey: ['local', 'kaizens'], queryFn: () => listLocalKaizens(database) });

  // The submit's confirmation is shown once: gone when the leader leaves or pulls to refresh.
  const clearSubmitted = useClearParams(Boolean(submitted), CLEAR_SUBMITTED);

  const all = kaizens.data ?? [];
  const { recent, approved, needsFix, drafts, waiting } = groupLeaderKaizens(all, Date.now());
  const list = (items: LocalKaizen[]) =>
    items.map((kaizen) => (
      <KaizenCard key={kaizen.id} kaizen={kaizen} arrived={kaizen.id === submitted} onPress={() => router.push(kaizenHref(kaizen))} />
    ));

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={syncing}
            onRefresh={() => {
              clearSubmitted();
              void sync().then(() => kaizens.refetch());
            }}
          />
        }
      >
        {submitted ? (
          <Slip arriving title={resubmitted ? t.resubmittedTitle : t.submittedTitle}>
            <SlipText>{t.submittedNote}</SlipText>
          </Slip>
        ) : null}

        {kaizens.isLoading ? null : all.length === 0 ? (
          <>
            <View style={styles.action}>
              <Button testID="kaizen-new" title={t.newButton} icon="add" onPress={() => router.navigate('/kaizen/new')} />
            </View>
            <EmptyState title={t.firstKaizenTitle} detail={t.firstKaizenDetail} />
          </>
        ) : (
          <>
            <SectionHead title={t.last30Days} />
            <View style={styles.tiles}>
              <KpiTile label={t.submitted} value={recent.length} context={t.byYou} />
              <KpiTile label={t.approved} value={approved.length} context={t.byCoordinator} band="ok" />
            </View>
            <SectionHead title={t.now} />
            <View style={styles.tiles}>
              <KpiTile label={t.waiting} value={waiting.length} context={t.forReview} band="warn" />
              <KpiTile label={t.needsFix} value={needsFix.length} context={t.sentBackToYou} band="crit" />
            </View>
            <View style={styles.action}>
              <Button testID="kaizen-new" title={t.newButton} icon="add" onPress={() => router.navigate('/kaizen/new')} />
            </View>

            {/* An action list, not a report: there only when something is the leader's to fix. */}
            {needsFix.length ? (
              <>
                <SectionHead title={t.needsFixSection} />
                {list(needsFix)}
              </>
            ) : null}

            {drafts.length ? (
              <>
                <SectionHead title={t.draftsSection} />
                {list(drafts)}
              </>
            ) : null}

            {waiting.length ? (
              <>
                <SectionHead title={t.awaitingSection} />
                {list(waiting)}
              </>
            ) : null}

            <SectionHead title={t.approvedSection} />
            {approved.length ? list(approved) : <EmptyState title={t.noneApproved} />}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * A one-time message carried in this screen's params: cleared when the screen loses focus
 * (or on `clear()`, e.g. a pull to refresh), so it is not there on the next visit. This
 * screen's own `navigation`, not `router`: on blur, `router` already points at the next one.
 * `cleared` must be a module constant, or the effect re-runs (and clears) on every render.
 */
function useClearParams(set: boolean, cleared: Record<string, undefined>) {
  const navigation = useNavigation();
  const clear = useCallback(() => {
    if (set) navigation.setParams(cleared as never);
  }, [navigation, set, cleared]);
  useFocusEffect(useCallback(() => clear, [clear]));
  return clear;
}

/**
 * GEMBA's KPI tile, one magnet per figure as the prototype had them: label, figure, one line
 * of context, then the band. The band is the colour's shape, so the tile reads without it.
 */
function KpiTile({ label, value, context, band }: { label: string; value: number; context: string; band?: Band }) {
  const styles = useStyles();
  return (
    <View style={styles.tile}>
      <Card style={styles.tileCard} accessible accessibilityLabel={`${label}: ${value}, ${context}`}>
        <View style={styles.tileBody}>
          <Label>{label}</Label>
          <Figure size={29} {...(band ? { band } : {})}>
            {String(value)}
          </Figure>
          <Muted>{context}</Muted>
        </View>
        {band ? <StatusBand band={band} /> : null}
      </Card>
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.xl },
  action: { marginVertical: theme.space.md },
  tiles: { flexDirection: 'row', gap: theme.space.sm },
  tile: { flex: 1 },
  // The band runs edge to edge along the bottom, under the padding, like `gb-band`.
  tileCard: { padding: 0, flex: 1, justifyContent: 'space-between' },
  tileBody: { padding: theme.space.md, gap: 2 },
}));
