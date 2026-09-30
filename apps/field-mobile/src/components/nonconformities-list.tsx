import { useCallback } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Stack } from 'expo-router';
import { awaitsResponse, isOverdue } from '@audit5s/domain';
import { Card, Chip, EmptyState, ErrorBanner, Muted, Screen, SectionHead, Tape } from './ui';
import { syncCatalogue } from '../lib/catalogue';
import {
  listLocalCorrectiveActions,
  statusLabel,
  type LocalAction,
} from '../lib/db/corrective-action.repository';
import { useLocalDatabase } from '../lib/db/provider';
import { formatDate } from '../lib/format';
import { createThemedStyles, useTheme } from '../lib/theme';

/**
 * §2.4 step 5, "Opens Nonconformities": every open item of the Zone Leader's Unit — from
 * external audits and cross audits alike, and from every Zone, not only the ones they lead
 * (R-3b) — **rendered from SQLite**, so the list is there with the radio off. Items the
 * device has answered but not yet synced say so.
 *
 * Rows carry the web table's severity rail: crit when overdue, warn while waiting.
 *
 * The Zone Leader's own tab since R-39, and still the `/actions` screen the Units tab and
 * a signed link lead to. Pull down to fetch the catalogue, as on the Units tab.
 */
export function NonconformitiesScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const actions = useQuery({
    queryKey: ['local', 'corrective-actions'],
    queryFn: () => listLocalCorrectiveActions(database),
  });
  const sync = useMutation({
    mutationFn: () => syncCatalogue(database),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
    },
  });

  const now = Date.now();
  const rows = [...(actions.data ?? [])].sort(
    (a, b) => Number(awaitsResponse(b.effectiveStatus)) - Number(awaitsResponse(a.effectiveStatus)),
  );
  const waiting = rows.filter((a) => awaitsResponse(a.effectiveStatus) && !a.pendingSubmissionId).length;
  const overdue = rows.filter((a) => a.dueAt && isOverdue(a.effectiveStatus, a.dueAt, now)).length;

  const renderItem = useCallback(
    ({ item }: { item: LocalAction }) => {
      const late = Boolean(item.dueAt && isOverdue(item.effectiveStatus, item.dueAt, Date.now()));
      const open = awaitsResponse(item.effectiveStatus) && !item.pendingSubmissionId;
      return (
        <Link href={{ pathname: '/actions/[actionId]', params: { actionId: item.id } }} asChild>
          <Card rail={late ? 'crit' : open ? 'warn' : 'none'} accessibilityRole="button">
            <View style={styles.row}>
              <Text style={styles.zone}>
                Zone {item.zoneCode} — {item.zoneName}
              </Text>
              <Chip tone={open ? 'warn' : 'muted'}>{statusLabel(item)}</Chip>
            </View>
            <Muted>
              {item.questionGlobalOrder
                ? `Q${item.questionGlobalOrder}: ${item.questionText ?? ''}`
                : item.suggestion
                  ? `Overall action ${item.suggestionNo ?? ''}: ${item.suggestion}`
                  : 'Walk-by observation'}
            </Muted>
            {item.dueAt ? (
              <Text style={[styles.due, late && styles.late]}>
                Due {formatDate(item.dueAt)}
                {late ? ', overdue' : ''}
              </Text>
            ) : null}
          </Card>
        </Link>
      );
    },
    [styles],
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Nonconformities' }} />
      <FlatList
        data={rows}
        keyExtractor={(action) => action.id}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={sync.isPending}
            onRefresh={() => sync.mutate()}
            colors={[theme.color.ink]}
            progressBackgroundColor={theme.color.tile}
          />
        }
        ListHeaderComponent={
          <>
            <ErrorBanner
              message={
                sync.error ? 'Could not refresh. Showing what is stored on this device; pull down to try again.' : null
              }
            />
            {rows.length > 0 ? (
              <SectionHead
                title={waiting > 0 ? `${waiting} waiting for you` : 'All answered'}
                description="Stored on this device. Answered items say so until they sync. Pull down to refresh."
                action={overdue > 0 ? <Tape>{overdue} overdue</Tape> : null}
              />
            ) : null}
          </>
        }
        ListEmptyComponent={<EmptyState title="Nothing open" detail="Pull down to check again." />}
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: theme.space.sm,
    marginBottom: 6,
  },
  zone: { fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink, flexShrink: 1 },
  due: {
    fontFamily: theme.family.mono,
    fontSize: 12,
    color: theme.color.ink2,
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  late: { fontFamily: theme.family.monoMedium, color: theme.color.crit },
}));
