import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Tabs, useRouter } from 'expo-router';
import type { Audit, AuditAssignment, AuditStatus, AuditType, Page } from '@audit5s/contracts';
import {
  ActionSheet,
  Card,
  CardHeader,
  Chip,
  Data,
  EmptyState,
  ErrorBanner,
  Figure,
  HeaderAction,
  Muted,
  Screen,
  SectionHead,
  Segmented,
  Slip,
  SlipText,
} from '../../components/ui';
import { api } from '../../lib/api';
import { listLocalAudits } from '../../lib/db/audit.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { formatDate, formatPct } from '../../lib/format';
import { AUDIT_STATUS_LABELS, AUDIT_STATUS_TONE, AUDIT_TYPE_LABELS, humanize, isFinished } from '../../lib/labels';
import { useSession } from '../../lib/session';
import { bandOf, createThemedStyles, useTheme } from '../../lib/theme';

type Board = 'ACTIVE' | 'DONE' | 'ASSIGNED';

const BOARDS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DONE', label: 'Completed' },
  { value: 'ASSIGNED', label: 'Assigned' },
] as const;

const HEAD: Record<Board, { title: (n: number) => string; description: string; empty: string }> = {
  ACTIVE: {
    title: (n) => `${n} active`,
    description: 'Started, in progress or paused, on any phone.',
    empty: 'Nobody is auditing right now.',
  },
  DONE: {
    title: (n) => `${n} completed`,
    description: 'Open one for its scores, reports and corrections.',
    empty: 'No audit has been completed yet.',
  },
  ASSIGNED: {
    title: (n) => `${n} assigned`,
    description: 'Waiting for the consultant to start.',
    empty: 'Nothing is waiting to be started.',
  },
};

/**
 * Every audit in reach — the organization's for a Super Admin, the own Unit's for a Coordinator
 * (R-24): what is running, what is finished (with its reports and the correction path), and
 * what is assigned but not started. An audit this phone is running itself sits on top as the
 * one slip.
 */
export default function AuditsScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const database = useLocalDatabase();
  const { can } = useSession();
  const [board, setBoard] = useState<Board>('ACTIVE');
  const [adding, setAdding] = useState(false);

  // Only what the role holds: a Coordinator neither assigns nor runs an audit.
  const newAudit: Array<{ label: string; detail?: string; onPress: () => void }> = [];
  if (can('audit_assignment', 'create')) {
    newAudit.push({ label: 'Assign to a consultant', detail: 'They run it on their phone', onPress: () => router.push('/manage/assign') });
  }
  if (can('audit', 'create_external')) {
    newAudit.push({ label: 'Start one myself', detail: 'Pick the Unit, then take the selfie', onPress: () => router.push('/units') });
  }

  const mine = useQuery({ queryKey: ['local', 'audits'], queryFn: () => listLocalAudits(database) });
  const resumable = (mine.data ?? []).find((audit) => audit.status === 'IN_PROGRESS' || audit.status === 'PAUSED');

  const active = useQuery({
    queryKey: ['audits', 'active'],
    queryFn: () => api.get<Page<Audit>>('/audits?limit=200&active=true'),
    enabled: board === 'ACTIVE',
    refetchInterval: 30_000,
  });
  const all = useQuery({
    queryKey: ['audits', 'all'],
    queryFn: () => api.get<Page<Audit>>('/audits?limit=200'),
    enabled: board === 'DONE',
  });
  const assignments = useQuery({
    queryKey: ['audit-assignments', 'open'],
    queryFn: () => api.get<Page<AuditAssignment>>('/audit-assignments?limit=200&open=true'),
    enabled: board === 'ASSIGNED',
  });

  const current = board === 'ACTIVE' ? active : board === 'DONE' ? all : assignments;
  const audits =
    board === 'ACTIVE'
      ? (active.data?.data ?? [])
      : (all.data?.data ?? [])
          .filter((audit) => isFinished(audit.status))
          .sort((a, b) => Date.parse(b.completedAt ?? '') - Date.parse(a.completedAt ?? ''));
  const count = board === 'ASSIGNED' ? (assignments.data?.data.length ?? 0) : audits.length;

  const renderAudit = useCallback(
    ({ item }: { item: Audit }) => {
      const finished = isFinished(item.status);
      const band = bandOf(item.totals.scorePercentage);
      return (
        <Card
          rail={finished && item.scored ? band : undefined}
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/manage/audit/[auditId]', params: { auditId: item.id } })}
        >
          <CardHeader
            title={item.unitName}
            description={`${AUDIT_TYPE_LABELS[item.auditType]} by ${item.auditorName}`}
            action={<Chip tone={AUDIT_STATUS_TONE[item.status]}>{AUDIT_STATUS_LABELS[item.status]}</Chip>}
          />
          <View style={styles.meta}>
            <Data>
              {finished && item.completedAt
                ? `Completed ${formatDate(item.completedAt)}`
                : item.startedAt
                  ? `Started ${formatDate(item.startedAt)}`
                  : 'Not started yet'}
            </Data>
            {finished && item.scored ? (
              <Figure band={band} size={22}>
                {formatPct(item.totals.scorePercentage)}
              </Figure>
            ) : null}
          </View>
        </Card>
      );
    },
    [styles, router],
  );

  const renderAssignment = useCallback(
    ({ item }: { item: AuditAssignment }) => (
      <Card>
        <CardHeader
          title={item.unitName}
          description={`${AUDIT_TYPE_LABELS[item.auditType]} for ${item.auditorName}`}
          action={<Chip>{humanize(item.status)}</Chip>}
        />
        <Data>{item.dueAt ? `Due ${formatDate(item.dueAt)}` : 'No due date'}</Data>
        {item.instructions ? <Muted>{item.instructions}</Muted> : null}
      </Card>
    ),
    [],
  );

  const header = (
    <>
      {resumable ? (
        <Slip
          accessibilityRole="button"
          title="Your audit on this phone"
          onPress={() => router.push({ pathname: '/audit/zones/[auditId]', params: { auditId: resumable.id } })}
        >
          <SlipText>
            {AUDIT_TYPE_LABELS[resumable.auditType as AuditType]},{' '}
            {AUDIT_STATUS_LABELS[resumable.status as AuditStatus].toLowerCase()}. Carry on where you stopped.
          </SlipText>
        </Slip>
      ) : null}
      <Segmented options={BOARDS} value={board} onChange={setBoard} />
      <ErrorBanner
        message={current.error ? 'Audits could not load. This needs a connection; pull down to try again.' : null}
      />
      {current.data ? <SectionHead title={HEAD[board].title(count)} description={HEAD[board].description} /> : null}
    </>
  );
  const empty = current.isLoading ? (
    <ActivityIndicator color={theme.color.ink} />
  ) : current.data ? (
    <EmptyState title="Nothing here" detail={HEAD[board].empty} />
  ) : null;
  const refresh = <RefreshControl refreshing={current.isRefetching} onRefresh={() => void current.refetch()} />;

  return (
    <Screen>
      <Tabs.Screen
        options={{
          // R-24: a Coordinator neither assigns nor runs an audit, so there is nothing to add.
          headerRight: () =>
            newAudit.length > 0 ? (
              <View style={styles.tools}>
                <HeaderAction testID="add-audit" title="+ Audit" accessibilityLabel="New audit" onPress={() => setAdding(true)} />
              </View>
            ) : null,
        }}
      />
      {board === 'ASSIGNED' ? (
        <FlatList
          key="assigned"
          data={assignments.data?.data ?? []}
          keyExtractor={(assignment) => assignment.id}
          renderItem={renderAssignment}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          refreshControl={refresh}
        />
      ) : (
        <FlatList
          key={board}
          data={audits}
          keyExtractor={(audit) => audit.id}
          renderItem={renderAudit}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          refreshControl={refresh}
        />
      )}
      <ActionSheet visible={adding} title="New audit" onClose={() => setAdding(false)} actions={newAudit} />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  tools: { marginRight: theme.space.md },
  meta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.space.sm },
}));
