import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Tabs, useRouter } from 'expo-router';
import type {
  Audit,
  CorrectiveAction,
  OrganizationOverview,
  Page,
  Unit,
  UnitOverview,
  User,
} from '@audit5s/contracts';
import { bandFor } from '@audit5s/domain';
import {
  ActionSheet,
  Card,
  Chip,
  Data,
  ErrorBanner,
  Figure,
  HeaderAction,
  Icon,
  type IconName,
  Label,
  Magnet,
  Screen,
  SectionHead,
  Slip,
  SlipText,
  StatusBand,
  TAB_ICON,
} from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate, formatPct } from '../../lib/format';
import { isRunning } from '../../lib/labels';
import { AuditCard } from '../../components/audit-card';
import { CallCrossAuditSheet } from '../../components/cross-audit-round';
import { FieldOverview } from '../../components/field-overview';
import { managesOnPhone, useSession } from '../../lib/session';
import { bandOf, createThemedStyles, iosHardShadow, useTheme } from '../../lib/theme';

/**
 * The Overview tab, which is two screens wearing one route.
 *
 * A Super Admin or Coordinator gets the management board below. A Consultant or Zone
 * Leader gets `FieldOverview` — the same first question asked of a different person: not
 * "is the organization running" but "what am I in the middle of". They are different
 * enough that sharing a body would be a screen of branches, and alike enough that they
 * belong on one tab: it is the place you land, whoever you are.
 *
 * One route rather than two also keeps the navigation honest — `/overview` resolves for
 * every signed-in role, so nothing that links to it has to know who is holding the phone.
 */
export default function OverviewScreen() {
  const { scope } = useSession();
  return managesOnPhone(scope?.role) ? <ManagementOverview /> : <FieldOverview />;
}

/**
 * The management board on a phone: the three counts that say whether things are running, the
 * one slip when something is overdue, the score, the Unit board, and who is auditing now.
 *
 * A Super Admin sees the organization. A Coordinator (R-24) sees their own Unit: the server
 * scopes every list to it, the score is the Unit's rather than the organization's, and the
 * Add menu offers only what the role holds.
 *
 * This is management, not field work, so it is live server data. It says so when it cannot
 * load rather than showing zeros.
 */
function ManagementOverview() {
  const styles = useStyles();
  const router = useRouter();
  const { scope, can } = useSession();
  const [adding, setAdding] = useState(false);

  const organizationWide = can('analytics', 'organization_dashboard');
  const ownUnitId = organizationWide ? null : (scope?.unitIds?.[0] ?? null);

  // ponytail: counts are the first 200 rows of each list, as the web does; switch to a count
  // endpoint if an organization outgrows that.
  const units = useQuery({ queryKey: ['units'], queryFn: () => api.get<Page<Unit>>('/units?limit=200') });
  const consultants = useQuery({
    queryKey: ['users', 'CONSULTANT', 'ACTIVE'],
    queryFn: () => api.get<Page<User>>('/users?limit=200&role=CONSULTANT&status=ACTIVE'),
  });
  const active = useQuery({
    queryKey: ['audits', 'active'],
    queryFn: () => api.get<Page<Audit>>('/audits?limit=200&active=true'),
    refetchInterval: 30_000,
  });
  const overdue = useQuery({
    queryKey: ['corrective-actions', 'overdue'],
    queryFn: () => api.get<Page<CorrectiveAction>>('/corrective-actions?limit=200&overdue=true'),
    refetchInterval: 60_000,
  });
  const org = useQuery({
    queryKey: ['analytics', 'organization'],
    queryFn: () => api.get<OrganizationOverview>('/analytics/organization/overview'),
    enabled: organizationWide,
  });
  const unit = useQuery({
    queryKey: ['analytics', 'unit', ownUnitId],
    queryFn: () => api.get<UnitOverview>(`/analytics/units/${ownUnitId}/overview`),
    enabled: ownUnitId !== null,
  });

  const queries = [units, consultants, active, overdue, organizationWide ? org : unit];
  const late = overdue.data?.data ?? [];
  const oldest = [...late].sort((a, b) => Date.parse(a.dueAt ?? '') - Date.parse(b.dueAt ?? ''))[0];
  const summary = organizationWide ? org.data : unit.data;
  const score = summary?.score.scorePercentage ?? null;
  const band = bandOf(score);
  const ownUnitName = units.data?.data.find((candidate) => candidate.id === ownUnitId)?.name;
  // As the Audits tab: one Unit in view leads each card with the auditor (R-42).
  const oneUnit = scope !== null && !scope.organizationWide && scope.unitIds.length === 1;
  // The Active board's audits — somebody is actually running them — for the list and the count.
  const running = (active.data?.data ?? []).filter((audit) => isRunning(audit.status));

  const addActions: Array<{ label: string; detail?: string; onPress: () => void }> = [];
  const coordinator = scope?.role === 'COORDINATOR';
  if (can('unit', 'create')) addActions.push({ label: 'New Unit', onPress: () => router.push('/manage/new-unit') });
  if (scope?.role === 'SUPER_ADMIN') {
    addActions.push(
      { label: 'New consultant', onPress: () => router.push({ pathname: '/manage/new-person', params: { role: 'CONSULTANT' } }) },
      { label: 'New coordinator', onPress: () => router.push({ pathname: '/manage/new-person', params: { role: 'COORDINATOR' } }) },
    );
  }
  if (can('audit_assignment', 'create')) {
    addActions.push({ label: 'Assign an audit', detail: 'A consultant runs it on their phone', onPress: () => router.push('/manage/assign') });
  }
  if (can('audit', 'create_external')) {
    addActions.push({ label: 'Start an audit myself', detail: 'Take the selfie, then select the Zone', onPress: () => router.push('/audit/start') });
  }
  // A Coordinator's own Unit (owner, 2026-10-14): its Zones, its Zone Leaders, its cross audits.
  if (coordinator && can('zone', 'create')) {
    addActions.push({ label: 'Add a Zone', detail: 'On My Unit', onPress: () => router.push({ pathname: '/my-unit', params: { add: 'zone' } }) });
  }
  if (can('user', 'create')) {
    addActions.push({
      label: coordinator ? 'Add a Zone Leader' : 'New zone leader',
      onPress: () => router.push({ pathname: '/manage/new-person', params: { role: 'ZONE_LEADER' } }),
    });
  }
  const [callingCross, setCallingCross] = useState(false);
  if (coordinator && can('unit', 'call_cross_audit') && ownUnitId) {
    addActions.push({
      label: 'Start a cross audit',
      detail: 'Pick the Zones — or all of them — and the date it is due',
      onPress: () => setCallingCross(true),
    });
  }

  return (
    <Screen>
      <Tabs.Screen
        options={{
          headerRight: () => (
            <View style={styles.tools}>
              <HeaderAction icon="notifications" title="Alerts" accessibilityLabel="Notifications" onPress={() => router.push('/notifications')} />
              {addActions.length > 0 ? (
                <HeaderAction icon="add" testID="add-new" title="New" accessibilityLabel="Add something" onPress={() => setAdding(true)} />
              ) : null}
            </View>
          ),
        }}
      />

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={queries.some((query) => query.isRefetching)}
            onRefresh={() => queries.forEach((query) => void query.refetch())}
          />
        }
      >
        <ErrorBanner
          message={
            queries.some((query) => query.isError)
              ? 'Some figures could not load. They need a connection; pull down to try again.'
              : null
          }
        />

        {/* The one slip: only when a human must act. */}
        {oldest ? (
          <Slip
            accessibilityRole="button"
            title={`${late.length} corrective action${late.length === 1 ? '' : 's'} overdue`}
            onPress={() => router.push('/review')}
          >
            <SlipText>
              Oldest is Zone {oldest.zoneCode} — {oldest.zoneName}, due{' '}
              {oldest.dueAt ? formatDate(oldest.dueAt) : 'without a date'}, owned by{' '}
              {oldest.assignedZoneLeaderName ?? 'nobody'}.
            </SlipText>
          </Slip>
        ) : null}

        <View style={styles.kpis}>
          <Kpi label={organizationWide ? 'Units' : 'Unit'} icon={TAB_ICON.units} value={count(units.data)} onPress={() => router.push('/units')} />
          <Kpi label="Consultants" icon={TAB_ICON.people} value={count(consultants.data)} onPress={() => router.push('/people')} />
          <Kpi label="Auditing" icon={TAB_ICON.audits} value={active.data ? String(running.length) : '—'} onPress={() => router.push('/audits')} />
        </View>

        <SectionHead
          title={organizationWide ? 'Organization score' : `${ownUnitName ?? 'Unit'} score`}
          description={summary ? `${summary.completedCount} completed audits, as the server scored them.` : null}
        />
        <Card>
          <View style={styles.scoreRow}>
            <Figure band={band} size={33}>
              {formatPct(score)}
            </Figure>
            {band === 'none' ? null : <Chip tone={band}>{bandFor(score)?.label}</Chip>}
          </View>
          <StatusBand band={band} />
          <View style={styles.facts}>
            <Data>
              {summary?.openNonconformities ?? 0} open nonconformities, {summary?.closedNonconformities ?? 0} closed
            </Data>
            <Data>{summary?.activeAuditors ?? 0} auditors active in the period</Data>
          </View>
        </Card>

        {organizationWide && (org.data?.unitRanking ?? []).length > 0 ? (
          <View style={styles.section}>
            <SectionHead title="Unit board" />
            {org.data!.unitRanking.map((ranked) => {
              const unitBand = bandOf(ranked.score.scorePercentage);
              return (
                <Card
                  key={ranked.unitId}
                  rail={unitBand}
                  accessibilityRole="button"
                  onPress={() => router.push({ pathname: '/manage/unit/[unitId]', params: { unitId: ranked.unitId } })}
                >
                  <View style={styles.rankRow}>
                    <Text style={styles.name}>{ranked.unitName}</Text>
                    <Figure band={unitBand} size={22}>
                      {formatPct(ranked.score.scorePercentage)}
                    </Figure>
                  </View>
                  <Data>{ranked.score.sampleCount} scored Zones</Data>
                </Card>
              );
            })}
          </View>
        ) : null}

        {/* The Audits tab's Active board in brief, worn the same way (`AuditCard`). */}
        <View style={styles.section}>
          <SectionHead
            title={oneUnit && ownUnitName ? `Auditing now · ${ownUnitName}` : 'Auditing now'}
            description={active.data && running.length === 0 ? 'Nobody is auditing right now.' : null}
          />
          {running.slice(0, 5).map((audit) => (
            <AuditCard key={audit.id} audit={audit} oneUnit={oneUnit} />
          ))}
          {running.length > 5 ? (
            <Card accessibilityRole="button" onPress={() => router.push('/audits')}>
              <Data>{`${running.length - 5} more on the Audits tab ›`}</Data>
            </Card>
          ) : null}
        </View>
      </ScrollView>

      <ActionSheet visible={adding} title="Add" onClose={() => setAdding(false)} actions={addActions} />
      <CallCrossAuditSheet unitId={ownUnitId ?? undefined} visible={callingCross} onClose={() => setCallingCross(false)} />
    </Screen>
  );
}

function count(page: Page<unknown> | undefined): string {
  return page ? String(page.data.length) : '—';
}

/**
 * `gb-kpi`: the destination's tab symbol, label, figure, lifted on the module picker's 5px
 * shadow with its ink band. The row stretches every tile to the tallest, so a label that
 * shrinks to fit never leaves one shorter than its neighbours. A tap goes to that tab.
 */
function Kpi({ label, value, icon, onPress }: { label: string; value: string; icon: IconName; onPress: () => void }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <Magnet offset={LIFT} style={styles.kpi}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        onPress={onPress}
        style={({ pressed }) => [styles.kpiFace, pressed && styles.kpiPressed]}
      >
        <Icon name={icon} color={theme.color.ink3} size={20} />
        <View style={styles.kpiText}>
          <Label fit>{label}</Label>
          <Figure size={32}>{value}</Figure>
        </View>
        <View style={styles.kpiBand} />
      </Pressable>
    </Magnet>
  );
}

/** GEMBA §2.2's hover / selected offset, as the module picker's tiles. */
const LIFT = 5;

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.xl },
  tools: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, marginRight: theme.space.md },
  kpis: { flexDirection: 'row', alignItems: 'stretch', gap: theme.space.sm, marginBottom: theme.space.lg },
  kpi: { flex: 1 },
  kpiFace: {
    flex: 1,
    minHeight: 112,
    justifyContent: 'space-between',
    backgroundColor: theme.color.tile,
    borderWidth: 2,
    borderColor: theme.color.edge,
    padding: theme.space.sm + 2,
    paddingBottom: theme.space.sm + 8,
    ...iosHardShadow(theme.color.hard, LIFT),
  },
  kpiPressed: { transform: [{ translateX: LIFT }, { translateY: LIFT }], shadowOpacity: 0 },
  kpiText: { marginTop: theme.space.sm },
  kpiBand: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 5, backgroundColor: theme.color.ink },
  section: { marginTop: theme.space.lg },
  scoreRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    gap: theme.space.md,
    marginBottom: 10,
  },
  facts: { marginTop: 10, gap: 2 },
  rankRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.space.sm },
  name: {
    flexShrink: 1,
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
  },
}));
