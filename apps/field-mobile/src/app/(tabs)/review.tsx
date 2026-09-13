import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import type { CorrectiveAction, Page } from '@audit5s/contracts';
import { awaitsResponse, awaitsReview, isOverdue } from '@audit5s/domain';
import {
  Card,
  CardHeader,
  Chip,
  Data,
  EmptyState,
  ErrorBanner,
  Screen,
  SectionHead,
  Segmented,
} from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { humanize } from '../../lib/labels';
import { useTheme } from '../../lib/theme';

type Filter = 'REVIEW' | 'OPEN' | 'ALL';

const ABOUT: Record<Filter, { title: string; description: string; empty: string }> = {
  REVIEW: {
    title: 'to review',
    description: 'Zone leaders have answered these. Verify the fix or reopen it.',
    empty: 'Nothing is waiting for your review.',
  },
  OPEN: {
    title: 'open',
    description: 'Waiting for the Zone leader. Overdue first.',
    empty: 'No corrective action is open.',
  },
  ALL: {
    title: 'in all',
    description: 'Every corrective action, overdue first.',
    empty: 'No audit has raised a corrective action yet.',
  },
};

/** The admin web's Corrective actions page at phone width: review first, overdue on top. */
export default function ReviewScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('REVIEW');

  const actions = useQuery({
    queryKey: ['corrective-actions', 'all'],
    queryFn: () => api.get<Page<CorrectiveAction>>('/corrective-actions?limit=200'),
    refetchInterval: 60_000,
  });

  const all = actions.data?.data ?? [];
  const now = Date.now();
  const toReview = all.filter((action) => awaitsReview(action.status)).length;
  const open = all.filter((action) => awaitsResponse(action.status)).length;
  const rows = all
    .filter((action) =>
      filter === 'REVIEW' ? awaitsReview(action.status) : filter === 'OPEN' ? awaitsResponse(action.status) : true,
    )
    .sort(
      (a, b) =>
        Number(isOverdue(b.status, b.dueAt, now)) - Number(isOverdue(a.status, a.dueAt, now)) ||
        Date.parse(a.openedAt) - Date.parse(b.openedAt),
    );

  const renderItem = useCallback(
    ({ item }: { item: CorrectiveAction }) => {
      const late = isOverdue(item.status, item.dueAt, Date.now());
      const reviewing = awaitsReview(item.status);
      return (
        <Card
          rail={late ? 'crit' : reviewing ? 'warn' : 'none'}
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/manage/action/[actionId]', params: { actionId: item.id } })}
        >
          <CardHeader
            title={`Zone ${item.zoneCode} — ${item.zoneName}`}
            description={
              item.questionGlobalOrder ? `Q${item.questionGlobalOrder}: ${item.questionText ?? ''}` : 'Walk-by observation'
            }
            action={
              <Chip tone={reviewing ? 'warn' : item.status === 'VERIFIED' ? 'ok' : item.status === 'REOPENED' ? 'crit' : 'muted'}>
                {humanize(item.status)}
              </Chip>
            }
          />
          <Data>
            {item.dueAt ? `Due ${formatDate(item.dueAt)}${late ? ', overdue' : ''}` : 'No due date'},{' '}
            {item.assignedZoneLeaderName ?? 'no owner'}
          </Data>
        </Card>
      );
    },
    [router],
  );

  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={(action) => action.id}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={actions.isRefetching} onRefresh={() => void actions.refetch()} />}
        ListHeaderComponent={
          <>
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'REVIEW', label: `Review ${toReview}` },
                { value: 'OPEN', label: `Open ${open}` },
                { value: 'ALL', label: 'All' },
              ]}
            />
            <ErrorBanner
              message={actions.error ? 'Corrective actions could not load. This needs a connection; pull down to try again.' : null}
            />
            {actions.data ? (
              <SectionHead title={`${rows.length} ${ABOUT[filter].title}`} description={ABOUT[filter].description} />
            ) : null}
          </>
        }
        ListEmptyComponent={
          actions.isLoading ? (
            <ActivityIndicator color={theme.color.ink} />
          ) : actions.data ? (
            <EmptyState title="Nothing here" detail={ABOUT[filter].empty} />
          ) : null
        }
      />
    </Screen>
  );
}
