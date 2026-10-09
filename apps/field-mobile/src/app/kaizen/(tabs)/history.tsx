import { FlatList, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { KaizenCard, kaizenHref } from '../../../components/kaizen-card';
import { Data, EmptyState, Screen } from '../../../components/ui';
import { listLocalKaizens } from '../../../lib/db/kaizen.repository';
import { useLocalDatabase } from '../../../lib/db/provider';
import { KAIZEN_STRINGS } from '../../../lib/kaizen-strings';
import { useLanguage } from '../../../lib/language-provider';
import { useSync } from '../../../lib/sync/provider';
import { createThemedStyles } from '../../../lib/theme';

/**
 * Every Kaizen of the leader's, newest first, whatever its status. The prototype's History
 * showed approved ones only; Overview already splits by status, and here a leader finds any
 * Kaizen they remember by its photos rather than by the state it happens to be in.
 */
export default function KaizenHistory() {
  const styles = useStyles();
  const router = useRouter();
  const database = useLocalDatabase();
  const { sync, syncing } = useSync();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const kaizens = useQuery({ queryKey: ['local', 'kaizens'], queryFn: () => listLocalKaizens(database) });
  const all = kaizens.data ?? [];

  return (
    <Screen>
      <FlatList
        data={all}
        keyExtractor={(kaizen) => kaizen.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={all.length ? <Data>{t.kaizenCount(all.length)}</Data> : null}
        ListEmptyComponent={kaizens.isLoading ? null : <EmptyState title={t.historyEmpty} />}
        renderItem={({ item }) => <KaizenCard kaizen={item} onPress={() => router.push(kaizenHref(item))} />}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={() => void sync().then(() => kaizens.refetch())} />}
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { padding: theme.space.lg, paddingBottom: theme.space.xl * 2, gap: theme.space.sm },
}));
