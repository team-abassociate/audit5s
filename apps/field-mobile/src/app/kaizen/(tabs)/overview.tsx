import { RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { KaizenCard, kaizenHref } from '../../../components/kaizen-card';
import { Button, EmptyState, Screen, SectionHead, StatGrid } from '../../../components/ui';
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
 * The Coordinator's Overview (the KPI card, the queue, Top 3) is step 6.
 */
export default function KaizenOverview() {
  const { can } = useSession();
  if (can('kaizen', 'create')) return <LeaderOverview />;
  return (
    <Screen>
      <EmptyState title="Kaizen" detail="The Coordinator's screens arrive in step 6." />
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
