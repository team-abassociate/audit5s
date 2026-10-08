import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { Kaizen, KaizenDashboard, KaizenDashboardPeriod, Page } from '@audit5s/contracts';
import { KaizenCard, cardFromServer, kaizenHref } from '../../../components/kaizen-card';
import { KpiCard } from '../../../components/kaizen-charts';
import { Button, EmptyState, ErrorBanner, Screen, SectionHead, Slip, StatGrid } from '../../../components/ui';
import { api } from '../../../lib/api';
import { listLocalKaizens, type LocalKaizen } from '../../../lib/db/kaizen.repository';
import { useLocalDatabase } from '../../../lib/db/provider';
import { KAIZEN_STRINGS } from '../../../lib/kaizen-strings';
import { useLanguage } from '../../../lib/language-provider';
import { useSession } from '../../../lib/session';
import { useSync } from '../../../lib/sync/provider';
import { createThemedStyles } from '../../../lib/theme';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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
            onRefresh={() => queries.forEach((query) => void query.refetch())}
          />
        }
      >
        <ErrorBanner message={queries.some((query) => query.isError) ? t.needsConnection : null} />
        {dashboard.data ? <KpiCard kpi={dashboard.data.kpi} period={period} onPeriod={setPeriod} /> : null}
        {/* The one slip: only when a review waits on this person. */}
        {can('kaizen', 'review') && waiting.length > 0 ? (
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
  const kaizens = useQuery({ queryKey: ['local', 'kaizens'], queryFn: () => listLocalKaizens(database) });

  const all = kaizens.data ?? [];
  const since = Date.now() - THIRTY_DAYS_MS;
  const recent = all.filter((k) => k.submittedAt !== null && Date.parse(k.submittedAt) >= since);
  const returned = all.filter((k) => k.status === 'SENT_BACK' || k.status === 'REJECTED');
  const drafts = all.filter((k) => k.status === 'DRAFT');
  const awaiting = all.filter((k) => k.status === 'SUBMITTED');
  const approved = recent.filter((k) => k.status === 'APPROVED');

  const list = (items: LocalKaizen[]) =>
    items.map((kaizen) => <KaizenCard key={kaizen.id} kaizen={kaizen} onPress={() => router.push(kaizenHref(kaizen))} />);

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => void sync().then(() => kaizens.refetch())} />}
      >
        <SectionHead title={t.last30Days} />
        <StatGrid
          items={[
            { label: t.submitted, value: String(recent.length) },
            { label: t.approved, value: String(approved.length), band: 'ok' },
            { label: t.pending, value: String(awaiting.length), band: 'warn' },
            { label: t.returned, value: String(returned.length), band: 'crit' },
          ]}
        />
        <View style={styles.action}>
          <Button testID="kaizen-new" title={t.newButton} onPress={() => router.navigate('/kaizen/new')} />
        </View>

        <SectionHead title={t.returnedSection} />
        {returned.length ? list(returned) : <EmptyState title={t.nothingReturned} />}

        {drafts.length ? (
          <>
            <SectionHead title={t.draftsSection} />
            {list(drafts)}
          </>
        ) : null}

        {awaiting.length ? (
          <>
            <SectionHead title={t.awaitingSection} />
            {list(awaiting)}
          </>
        ) : null}

        <SectionHead title={t.approvedSection} />
        {approved.length ? list(approved) : <EmptyState title={t.noneApproved} />}
      </ScrollView>
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { padding: theme.space.lg, paddingBottom: theme.space.xl * 2 },
  action: { marginVertical: theme.space.md },
}));
