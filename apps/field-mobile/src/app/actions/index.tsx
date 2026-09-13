import { useCallback } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Link, Stack } from 'expo-router';
import { awaitsResponse, isOverdue } from '@audit5s/domain';
import { Card, Chip, EmptyState, Muted, Screen, SectionHead, Tape } from '../../components/ui';
import {
  listLocalCorrectiveActions,
  statusLabel,
  type LocalAction,
} from '../../lib/db/corrective-action.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { formatDate } from '../../lib/format';
import { createThemedStyles } from '../../lib/theme';

/**
 * §2.4 step 5, "Opens Nonconformities": every open item of the Zone Leader's Unit — from
 * external audits and cross audits alike — **rendered from SQLite**, so the list is there
 * with the radio off. Items the device has answered but not yet synced say so.
 *
 * Rows carry the web table's severity rail: crit when overdue, warn while waiting.
 */
export default function NonconformitiesScreen() {
  const styles = useStyles();
  const database = useLocalDatabase();
  const actions = useQuery({
    queryKey: ['local', 'corrective-actions'],
    queryFn: () => listLocalCorrectiveActions(database),
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
              {item.questionGlobalOrder ? `Q${item.questionGlobalOrder}: ${item.questionText ?? ''}` : 'Walk-by observation'}
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
        ListHeaderComponent={
          rows.length > 0 ? (
            <SectionHead
              title={waiting > 0 ? `${waiting} waiting for you` : 'All answered'}
              description="Stored on this device. Answered items say so until they sync."
              action={overdue > 0 ? <Tape>{overdue} overdue</Tape> : null}
            />
          ) : null
        }
        ListEmptyComponent={
          <EmptyState title="Nothing open" detail="Pull the catalogue on the Units tab to check again." />
        }
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
