import { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Tabs, useRouter } from 'expo-router';
import type { Audit, AuditAssignment, AuditStatus, AuditType, Page, Unit } from '@audit5s/contracts';
import { AuditCard } from '../../components/audit-card';
import {
  ActionSheet,
  Card,
  Chip,
  Data,
  EmptyState,
  ErrorBanner,
  HeaderAction,
  Muted,
  Screen,
  SectionHead,
  Segmented,
  Slip,
  SlipText,
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
import { listLocalAudits } from '../../lib/db/audit.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { formatDate } from '../../lib/format';
import { AUDIT_STATUS_LABELS, AUDIT_TYPE_LABELS, humanize, isFinished, isRunning } from '../../lib/labels';
import { useSession } from '../../lib/session';
import { createThemedStyles, useTheme } from '../../lib/theme';

type Board = 'ACTIVE' | 'DONE' | 'ASSIGNED';

const BOARDS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DONE', label: 'Completed' },
  { value: 'ASSIGNED', label: 'Assigned' },
] as const;

const HEAD: Record<Board, { title: (n: number) => string; description: string; empty: string }> = {
  ACTIVE: {
    title: (n) => `${n} active`,
    description: 'Started, in progress or paused.',
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

/** The latest thing that happened to an audit — the order inside a Zone's group. */
function auditTime(audit: Audit): number {
  return Date.parse(audit.completedAt ?? audit.startedAt ?? audit.createdAt);
}

/**
 * Every audit in reach — the organization's for a Super Admin, the own Unit's for a Coordinator
 * (R-24): what is running, what is finished (with its reports and the correction path), and
 * what is assigned but not started. An audit this phone is running itself sits on top as the
 * one slip.
 *
 * A Coordinator may filter every board by Zone (R-43), exactly as on Actions: the header's
 * Zone button, a chip per chosen Zone, and the boards grouped under each, newest first. An
 * audit covering two chosen Zones is under both; an assignment is placed by the Zones it
 * suggests. See `zone-filter.tsx`.
 */
export default function AuditsScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const database = useLocalDatabase();
  const { can, scope } = useSession();
  // A Coordinator holds one Unit (M-1): naming it on every card says nothing. It is said once,
  // in the section head, and the card leads with who is auditing.
  const oneUnit = scope !== null && !scope.organizationWide && scope.unitIds.length === 1;
  const [board, setBoard] = useState<Board>('ACTIVE');
  const [adding, setAdding] = useState(false);
  const zoneFilter = useZoneFilter();

  // Only what the role holds: a Coordinator neither assigns nor runs an audit.
  const newAudit: Array<{ label: string; detail?: string; onPress: () => void }> = [];
  if (can('audit_assignment', 'create')) {
    newAudit.push({ label: 'Assign to a consultant', detail: 'They run it on their phone', onPress: () => router.push('/manage/assign') });
  }
  if (can('audit', 'create_external')) {
    newAudit.push({ label: 'Start one myself', detail: 'Pick the Unit, then take the selfie', onPress: () => router.push('/units') });
  }

  // The same query as My Unit's, so the name is usually cached already.
  const ownUnitId = oneUnit ? scope.unitIds[0] : undefined;
  const ownUnit = useQuery({
    queryKey: ['unit', ownUnitId],
    queryFn: () => api.get<Unit>(`/units/${ownUnitId}`),
    enabled: ownUnitId !== undefined,
  });
  const unitName = ownUnit.data?.name;
  const zones = useUnitZones(ownUnitId);

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
      ? (active.data?.data ?? []).filter((audit) => isRunning(audit.status))
      : (all.data?.data ?? [])
          .filter((audit) => isFinished(audit.status))
          .sort((a, b) => Date.parse(b.completedAt ?? '') - Date.parse(a.completedAt ?? ''));
  // An assignment whose audit has started is on the Active board already.
  const waiting = (assignments.data?.data ?? []).filter((assignment) => assignment.status !== 'IN_PROGRESS');
  const auditZones = (audit: Audit) => audit.zoneIds ?? [];
  const assignmentZones = (assignment: AuditAssignment) => assignment.suggestedZoneIds;
  const shownAudits = zoneFilter.active
    ? audits.filter((audit) => auditZones(audit).some((id) => zoneFilter.selected.includes(id)))
    : audits;
  const shownWaiting = zoneFilter.active
    ? waiting.filter((assignment) => assignmentZones(assignment).some((id) => zoneFilter.selected.includes(id)))
    : waiting;
  const count = board === 'ASSIGNED' ? shownWaiting.length : shownAudits.length;
  const zoneCounts = board === 'ASSIGNED' ? countByZone(waiting, assignmentZones) : countByZone(audits, auditZones);

  // Grouped by Zone while filtered; one headless section otherwise. An empty section still
  // counts as content and would hide the empty state, so none is passed.
  const auditSections: Array<{ zone: ZoneOption | null; data: Audit[] }> = zoneFilter.active
    ? groupByZone(shownAudits, zones, zoneFilter.selected, auditZones, auditTime)
    : shownAudits.length > 0
      ? [{ zone: null, data: shownAudits }]
      : [];
  const assignmentSections: Array<{ zone: ZoneOption | null; data: AuditAssignment[] }> = zoneFilter.active
    ? groupByZone(shownWaiting, zones, zoneFilter.selected, assignmentZones, (assignment) => Date.parse(assignment.createdAt))
    : shownWaiting.length > 0
      ? [{ zone: null, data: shownWaiting }]
      : [];
  const sectionHead = ({ section }: { section: { zone: ZoneOption | null; data: readonly unknown[] } }) =>
    section.zone ? <ZoneGroupHead zone={section.zone} count={section.data.length} noun={['audit', 'audits']} /> : null;

  const renderAudit = useCallback(
    ({ item }: { item: Audit }) => <AuditCard audit={item} oneUnit={oneUnit} />,
    [oneUnit],
  );

  const renderAssignment = useCallback(
    ({ item }: { item: AuditAssignment }) => (
      <Card>
        <View style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.title}>{oneUnit ? item.auditorName : item.unitName}</Text>
            <Muted>
              {oneUnit ? AUDIT_TYPE_LABELS[item.auditType] : `${AUDIT_TYPE_LABELS[item.auditType]} for ${item.auditorName}`}
            </Muted>
            <Data>{item.dueAt ? `Due ${formatDate(item.dueAt)}` : 'No due date'}</Data>
          </View>
          <View style={styles.side}>
            <Chip>{humanize(item.status)}</Chip>
          </View>
        </View>
        {item.instructions ? <Muted>{item.instructions}</Muted> : null}
      </Card>
    ),
    [styles, oneUnit],
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
      <ZoneFilterChips zones={zones} selected={zoneFilter.selected} onChange={zoneFilter.setSelected} />
      <ErrorBanner
        message={current.error ? 'Audits could not load. This needs a connection; pull down to try again.' : null}
      />
      {current.data ? (
        <SectionHead
          title={unitName ? `${HEAD[board].title(count)} · ${unitName}` : HEAD[board].title(count)}
          description={
            // R-39: a Coordinator opens a finished audit for its scores; reports are not theirs.
            (board === 'DONE' && !can('report', 'read_snapshot')
              ? 'Open one for its scores and findings.'
              : HEAD[board].description) + (zoneFilter.active ? ' Grouped by zone, newest first.' : '')
          }
        />
      ) : null}
    </>
  );
  const empty = current.isLoading ? (
    <ActivityIndicator color={theme.color.ink} />
  ) : current.data ? (
    <EmptyState
      title="Nothing here"
      detail={zoneFilter.active ? 'Nothing on this board in the zones you chose.' : HEAD[board].empty}
    />
  ) : null;
  const refresh = <RefreshControl refreshing={current.isRefetching} onRefresh={() => void current.refetch()} />;

  return (
    <Screen>
      <Tabs.Screen
        options={{
          // R-24: a Coordinator neither assigns nor runs an audit, so there is nothing to add.
          headerRight: () =>
            newAudit.length > 0 || ownUnitId ? (
              <View style={styles.tools}>
                {ownUnitId ? <ZoneFilterButton count={zoneFilter.selected.length} onPress={zoneFilter.show} /> : null}
                {newAudit.length > 0 ? (
                  <HeaderAction testID="add-audit" title="+ Audit" accessibilityLabel="New audit" onPress={() => setAdding(true)} />
                ) : null}
              </View>
            ) : null,
        }}
      />
      {board === 'ASSIGNED' ? (
        <SectionList
          key="assigned"
          sections={assignmentSections}
          keyExtractor={(assignment) => assignment.id}
          renderItem={renderAssignment}
          renderSectionHeader={sectionHead}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          refreshControl={refresh}
        />
      ) : (
        <SectionList
          key={board}
          sections={auditSections}
          keyExtractor={(audit) => audit.id}
          renderItem={renderAudit}
          renderSectionHeader={sectionHead}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          refreshControl={refresh}
        />
      )}
      <ActionSheet visible={adding} title="New audit" onClose={() => setAdding(false)} actions={newAudit} />
      <ZoneFilterSheet
        visible={zoneFilter.open}
        zones={zones}
        selected={zoneFilter.selected}
        counts={zoneCounts}
        onChange={zoneFilter.setSelected}
        onClose={zoneFilter.hide}
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  tools: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, marginRight: theme.space.md },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.md },
  text: { flex: 1, gap: 2 },
  side: { alignItems: 'flex-end', gap: theme.space.sm },
  title: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
}));
