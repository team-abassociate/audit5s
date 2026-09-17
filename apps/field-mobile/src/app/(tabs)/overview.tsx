import { useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
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
  CardHeader,
  Chip,
  Data,
  ErrorBanner,
  Figure,
  HeaderAction,
  Label,
  Screen,
  SectionHead,
  Slip,
  SlipText,
  StatusBand,
} from '../../components/ui';
import { api } from '../../lib/api';
import { formatDate, formatPct } from '../../lib/format';
import { AUDIT_STATUS_LABELS, AUDIT_STATUS_TONE, AUDIT_TYPE_LABELS } from '../../lib/labels';
import { useSession } from '../../lib/session';
import { bandOf, createThemedStyles } from '../../lib/theme';

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
export default function OverviewScreen() {
  const styles = useStyles();
  const router = useRouter();
  const { scope, can } = useSession();
  const [adding, setAdding] = useState(false);

  const organizationWide = can('analytics', 'organization_dashboard');
  const ownUnitId = organizationWide ? null : (scope?.unitIds[0] ?? null);

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

  const addActions: Array<{ label: string; detail?: string; onPress: () => void }> = [];
  if (can('unit', 'create')) addActions.push({ label: 'New Unit', onPress: () => router.push('/manage/new-unit') });
  if (scope?.role === 'SUPER_ADMIN') {
    addActions.push(
      { label: 'New consultant', onPress: () => router.push({ pathname: '/manage/new-person', params: { role: 'CONSULTANT' } }) },
      { label: 'New coordinator', onPress: () => router.push({ pathname: '/manage/new-person', params: { role: 'COORDINATOR' } }) },
    );
  }
  if (can('user', 'create')) {
    addActions.push({
      label: 'New zone leader',
      onPress: () => router.push({ pathname: '/manage/new-person', params: { role: 'ZONE_LEADER' } }),
    });
  }
  if (can('audit_assignment', 'create')) {
    addActions.push({ label: 'Assign an audit', detail: 'A consultant runs it on their phone', onPress: () => router.push('/manage/assign') });
  }
  if (can('audit', 'create_external')) {
    addActions.push({ label: 'Start an audit myself', detail: 'Pick the Unit, then take the selfie', onPress: () => router.push('/units') });
  }

  return (
    <Screen>
      <Tabs.Screen
        options={{
          headerRight: () => (
            <View style={styles.tools}>
              <HeaderAction title="Alerts" accessibilityLabel="Notifications" onPress={() => router.push('/notifications')} />
              {addActions.length > 0 ? (
                <HeaderAction testID="add-new" title="+ New" accessibilityLabel="Add something" onPress={() => setAdding(true)} />
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
          <Kpi label={organizationWide ? 'Units' : 'Unit'} value={count(units.data)} onPress={() => router.push('/units')} />
          <Kpi label="Consultants" value={count(consultants.data)} onPress={() => router.push('/people')} />
          <Kpi label="Auditing" value={count(active.data)} onPress={() => router.push('/audits')} />
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

        <View style={styles.section}>
          <SectionHead
            title="Auditing now"
            description={active.data && active.data.data.length === 0 ? 'Nobody is auditing right now.' : null}
          />
          {(active.data?.data ?? []).slice(0, 5).map((audit) => (
            <Card
              key={audit.id}
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/manage/audit/[auditId]', params: { auditId: audit.id } })}
            >
              <CardHeader
                title={audit.unitName}
                description={`${AUDIT_TYPE_LABELS[audit.auditType]} by ${audit.auditorName}`}
                action={<Chip tone={AUDIT_STATUS_TONE[audit.status]}>{AUDIT_STATUS_LABELS[audit.status]}</Chip>}
              />
              <Data>{audit.startedAt ? `Started ${formatDate(audit.startedAt)}` : 'Not started yet'}</Data>
            </Card>
          ))}
        </View>
      </ScrollView>

      <ActionSheet visible={adding} title="Add" onClose={() => setAdding(false)} actions={addActions} />
    </Screen>
  );
}

function count(page: Page<unknown> | undefined): string {
  return page ? String(page.data.length) : '—';
}

/** `gb-kpi`: label, figure. A tap goes to the tab the number comes from. */
function Kpi({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const styles = useStyles();
  return (
    <View style={styles.kpi}>
      <Card accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} onPress={onPress}>
        <Label fit>{label}</Label>
        <Figure>{value}</Figure>
      </Card>
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.xl },
  tools: { flexDirection: 'row', alignItems: 'center', gap: theme.space.sm, marginRight: theme.space.md },
  kpis: { flexDirection: 'row', gap: theme.space.sm, marginBottom: theme.space.md },
  kpi: { flex: 1 },
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
