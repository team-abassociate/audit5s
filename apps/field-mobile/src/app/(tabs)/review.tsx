import { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Tabs, useRouter } from 'expo-router';
import type { CorrectiveAction, Page } from '@audit5s/contracts';
import { awaitsResponse, awaitsReview, isOverdue, isReviewable, isUnapprovedClosure } from '@audit5s/domain';
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
import {
  ZoneFilterButton,
  ZoneFilterChips,
  ZoneFilterSheet,
  ZoneGroupHead,
  countByZone,
  groupByZone,
  useUnitZones,
  useZoneFilter,
  type ZoneOption,
} from '../../components/zone-filter';
import { api } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { ACTION_STATUS_LABELS, ACTION_STATUS_TONE } from '../../lib/labels';
import { useSession } from '../../lib/session';
import { createThemedStyles, useTheme } from '../../lib/theme';

type Filter = 'REVIEW' | 'OPEN' | 'CLOSED' | 'ALL';

const ABOUT: Record<Filter, { title: string; description: string; empty: string }> = {
  // R-43: a "not possible" waits for a reviewer; a closure may be approved or disapproved,
  // and need not be.
  REVIEW: {
    title: 'to review',
    description: '"Not possible" answers need your decision. Closures may be approved or disapproved; that is optional.',
    empty: 'Nothing is waiting for your review.',
  },
  OPEN: {
    title: 'open',
    description: 'Waiting for the Zone leader. Overdue first.',
    empty: 'No corrective action is open.',
  },
  // R-39: who closed each one and when — for the Coordinator above all, who chases the work.
  CLOSED: {
    title: 'closed',
    description: 'Closed, newest first, with who closed each one and when.',
    empty: 'Nothing has been closed yet.',
  },
  ALL: {
    title: 'in all',
    description: 'Every corrective action, overdue first.',
    empty: 'No audit has raised a corrective action yet.',
  },
};

/** The latest thing that happened to an action — the order inside a Zone's group. */
function latestAt(action: CorrectiveAction): number {
  return Math.max(
    ...[action.openedAt, action.lastSubmittedAt, action.resolvedAt]
      .filter((at): at is string => at !== null)
      .map((at) => Date.parse(at)),
  );
}

/**
 * The admin web's Corrective actions page at phone width: review first, overdue on top.
 *
 * A Coordinator (one Unit) may filter it by Zone (R-43): the header's Zone button, a chip
 * per chosen Zone, and the list grouped under each, newest first. See `zone-filter.tsx`.
 */
export default function ReviewScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const { scope } = useSession();
  const [filter, setFilter] = useState<Filter>('REVIEW');
  const zoneFilter = useZoneFilter();

  // A Super Admin's list spans Units, whose Zone numbers repeat; the filter is the one-Unit view's.
  const ownUnitId = scope !== null && !scope.organizationWide && scope.unitIds.length === 1 ? scope.unitIds[0] : undefined;
  const zones = useUnitZones(ownUnitId);

  const actions = useQuery({
    queryKey: ['corrective-actions', 'all'],
    queryFn: () => api.get<Page<CorrectiveAction>>('/corrective-actions?limit=200'),
    refetchInterval: 60_000,
  });

  const all = actions.data?.data ?? [];
  // The board counts follow the Zone filter, so "Review 2" means two in the Zones chosen.
  const inZones = zoneFilter.active ? all.filter((action) => zoneFilter.selected.includes(action.zoneId)) : all;
  const now = Date.now();
  const toReview = inZones.filter((action) => isReviewable(action.status, action.verifiedByUserId)).length;
  const open = inZones.filter((action) => awaitsResponse(action.status)).length;
  const closed = inZones.filter((action) => action.status === 'VERIFIED').length;
  const onBoard = (action: CorrectiveAction) =>
    filter === 'REVIEW'
      ? isReviewable(action.status, action.verifiedByUserId)
      : filter === 'OPEN'
        ? awaitsResponse(action.status)
        : filter === 'CLOSED'
          ? action.status === 'VERIFIED'
          : true;
  const board = all.filter(onBoard);
  const rows = inZones
    .filter(onBoard)
    .sort((a, b) =>
      filter === 'CLOSED'
        ? Date.parse(b.resolvedAt ?? b.openedAt) - Date.parse(a.resolvedAt ?? a.openedAt)
        : // A required review before an optional approval, then overdue, then oldest.
          Number(awaitsReview(b.status)) - Number(awaitsReview(a.status)) ||
          Number(isOverdue(b.status, b.dueAt, now)) - Number(isOverdue(a.status, a.dueAt, now)) ||
          Date.parse(a.openedAt) - Date.parse(b.openedAt),
    );
  const zoneOf = (action: CorrectiveAction) => [action.zoneId];
  const sections: Array<{ zone: ZoneOption | null; data: CorrectiveAction[] }> = zoneFilter.active
    ? groupByZone(rows, zones, zoneFilter.selected, zoneOf, latestAt)
    : rows.length > 0
      ? [{ zone: null, data: rows }]
      : []; // An empty section still counts as content, and would hide the empty state.

  const renderItem = useCallback(
    ({ item }: { item: CorrectiveAction }) => {
      const late = isOverdue(item.status, item.dueAt, Date.now());
      const reviewing = awaitsReview(item.status);
      const unapproved = isUnapprovedClosure(item.status, item.verifiedByUserId);
      return (
        <Card
          rail={late ? 'crit' : reviewing ? 'warn' : 'none'}
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/manage/action/[actionId]', params: { actionId: item.id } })}
        >
          <CardHeader
            title={`Zone ${item.zoneCode} — ${item.zoneName}`}
            description={
              item.questionGlobalOrder
                ? `Q${item.questionGlobalOrder}: ${item.questionText ?? ''}`
                : item.suggestion
                  ? `Overall action ${item.suggestionNo ?? ''}: ${item.suggestion}`
                  : 'Walk-by observation'
            }
            action={<Chip tone={ACTION_STATUS_TONE[item.status]}>{ACTION_STATUS_LABELS[item.status]}</Chip>}
          />
          <Data>
            {item.status === 'VERIFIED' && item.resolvedAt
              ? `Closed by ${item.closedByName ?? 'unknown'}, ${formatDateTime(item.resolvedAt)}`
              : `${item.dueAt ? `Due ${formatDate(item.dueAt)}${late ? ', overdue' : ''}` : 'No due date'}, ${item.assignedZoneLeaderName ?? 'no owner'}`}
          </Data>
          {item.status === 'VERIFIED' ? (
            <Data>{unapproved ? 'Not reviewed' : `✓ Approved by ${item.verifiedByName ?? 'a reviewer'}`}</Data>
          ) : null}
        </Card>
      );
    },
    [router],
  );

  return (
    <Screen>
      <Tabs.Screen
        options={{
          headerRight: () =>
            ownUnitId ? (
              <View style={styles.tools}>
                <ZoneFilterButton count={zoneFilter.selected.length} onPress={zoneFilter.show} />
              </View>
            ) : null,
        }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(action) => action.id}
        renderItem={renderItem}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) =>
          section.zone ? <ZoneGroupHead zone={section.zone} count={section.data.length} noun={['action', 'actions']} /> : null
        }
        refreshControl={<RefreshControl refreshing={actions.isRefetching} onRefresh={() => void actions.refetch()} />}
        ListHeaderComponent={
          <>
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'REVIEW', label: `Review ${toReview}` },
                { value: 'OPEN', label: `Open ${open}` },
                { value: 'CLOSED', label: `Closed ${closed}` },
                { value: 'ALL', label: 'All' },
              ]}
            />
            <ZoneFilterChips zones={zones} selected={zoneFilter.selected} onChange={zoneFilter.setSelected} />
            <ErrorBanner
              message={actions.error ? 'Corrective actions could not load. This needs a connection; pull down to try again.' : null}
            />
            {actions.data ? (
              <SectionHead
                title={`${rows.length} ${ABOUT[filter].title}`}
                description={
                  zoneFilter.active ? `${ABOUT[filter].description} Grouped by zone, newest first.` : ABOUT[filter].description
                }
              />
            ) : null}
          </>
        }
        ListEmptyComponent={
          actions.isLoading ? (
            <ActivityIndicator color={theme.color.ink} />
          ) : actions.data ? (
            <EmptyState
              title="Nothing here"
              detail={zoneFilter.active ? 'Nothing on this board in the zones you chose.' : ABOUT[filter].empty}
            />
          ) : null
        }
      />
      <ZoneFilterSheet
        visible={zoneFilter.open}
        zones={zones}
        selected={zoneFilter.selected}
        counts={countByZone(board, zoneOf)}
        onChange={zoneFilter.setSelected}
        onClose={zoneFilter.hide}
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  tools: { marginRight: theme.space.md },
}));
