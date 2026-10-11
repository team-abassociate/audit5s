import { useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { Kaizen, KaizenStatus, Page } from '@audit5s/contracts';
import { KaizenCard, cardFromServer } from '../../../components/kaizen-card';
import { EmptyState, ErrorBanner, Screen, Segmented } from '../../../components/ui';
import { api } from '../../../lib/api';
import { KAIZEN_STRINGS } from '../../../lib/kaizen-strings';
import { useLanguage } from '../../../lib/language-provider';
import { createThemedStyles } from '../../../lib/theme';

type Filter = 'ALL' | Exclude<KaizenStatus, 'DRAFT'>;

/**
 * The Coordinator's Kaizens (§4.3): every submitted Kaizen in their Unit, filtered by status,
 * newest first. Live from the API (a Coordinator records nothing offline, R-24); the server
 * scopes it to the Unit, and never lists a DRAFT. Opens on Pending, the ones waiting on them.
 */
export default function KaizensScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const [filter, setFilter] = useState<Filter>('SUBMITTED');

  const list = useInfiniteQuery({
    // 'list' keeps this infinite query apart from Overview's plain ['kaizens', 'SUBMITTED']:
    // one key holding both shapes crashed this screen (no `pages`).
    queryKey: ['kaizens', 'list', filter],
    queryFn: ({ pageParam }) =>
      api.get<Page<Kaizen>>(
        `/kaizens?limit=50${filter === 'ALL' ? '' : `&status=${filter}`}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
  const rows = list.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={(kaizen) => kaizen.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.head}>
            {/* Five states do not fit 360dp in Hindi or Marathi (Phase 0.2): it scrolls instead. */}
            <Segmented
              scrolls
              options={[
                { value: 'ALL', label: t.all },
                { value: 'SUBMITTED', label: t.status.SUBMITTED },
                { value: 'APPROVED', label: t.status.APPROVED },
                { value: 'SENT_BACK', label: t.status.SENT_BACK },
                { value: 'REJECTED', label: t.status.REJECTED },
              ]}
              value={filter}
              onChange={setFilter}
            />
            <ErrorBanner message={list.isError ? t.listNeedsConnection : null} />
          </View>
        }
        ListEmptyComponent={list.isLoading || list.isError ? null : <EmptyState title={t.queueEmpty} />}
        renderItem={({ item }) => (
          <KaizenCard
            kaizen={cardFromServer(item)}
            author={`${item.authorName} · ${item.zoneCode}`}
            onPress={() => router.push({ pathname: '/kaizen/[kaizenId]', params: { kaizenId: item.id } })}
          />
        )}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        refreshControl={<RefreshControl refreshing={list.isRefetching} onRefresh={() => void list.refetch()} />}
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.xl, gap: theme.space.sm },
  head: { gap: theme.space.sm, marginBottom: theme.space.sm },
}));
