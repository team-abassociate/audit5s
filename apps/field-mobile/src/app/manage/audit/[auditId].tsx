import { useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { AuditDetail, Page, ReportDownloadUrl, ReportKind, ReportSnapshot } from '@audit5s/contracts';
import { bandFor, zoneDisplayLabel } from '@audit5s/domain';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Data,
  EmptyState,
  ErrorBanner,
  Figure,
  LedgerRow,
  Muted,
  Screen,
  StatusBand,
} from '../../../components/ui';
import { api, problemMessage } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { formatDateTime, formatPct } from '../../../lib/format';
import { AUDIT_STATUS_LABELS, AUDIT_STATUS_TONE, AUDIT_TYPE_LABELS, humanize, isFinished } from '../../../lib/labels';
import { bandOf, createThemedStyles, useTheme } from '../../../lib/theme';

const REPORT_KIND: Record<ReportKind, string> = {
  INITIAL_ZONE: 'Zone report',
  AFTER_EVIDENCE_ZONE: 'After-evidence report',
  MULTI_ZONE_SUMMARY: 'Unit summary report',
};

/**
 * One audit for a Super Admin: who ran it and where, the server's score, its Zones, its
 * reports (generate and open the PDF), and the way to correct it once completed. Reports are
 * frozen snapshots (§10.1), so opening one never re-renders it.
 */
export default function ManageAuditScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<unknown>(null);
  // R-24: a Coordinator reads audits and opens reports; generating and correcting are the Super Admin's.
  const { can } = useSession();
  const mayGenerate = can('report', 'generate');

  const detail = useQuery({ queryKey: ['audit', auditId], queryFn: () => api.get<AuditDetail>(`/audits/${auditId}`) });
  const finished = detail.data ? isFinished(detail.data.status) : false;
  const reports = useQuery({
    queryKey: ['reports', 'audit', auditId],
    queryFn: () => api.get<Page<ReportSnapshot>>(`/reports?limit=50&auditId=${auditId}`),
    enabled: finished,
    // A queued report renders in the background; the list notices without a reload.
    refetchInterval: (query) =>
      (query.state.data?.data ?? []).some((row) => row.status === 'QUEUED' || row.status === 'RENDERING') ? 4_000 : false,
  });
  const generate = useMutation({
    mutationFn: (auditZoneId: string) => api.post<ReportSnapshot>('/reports/generate', { kind: 'INITIAL_ZONE', auditZoneId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reports', 'audit', auditId] }),
  });
  // The zone summary report (`MULTI_ZONE_SUMMARY`) spans Zones rather than one audit, so its
  // snapshots carry no audit of their own: they are listed from the Unit, and the ones that
  // include a Zone of this audit are shown here.
  const summaries = useQuery({
    queryKey: ['reports', 'audit', auditId, 'summaries', detail.data?.unitId],
    queryFn: () =>
      api.get<Page<ReportSnapshot>>(`/reports?limit=50&kind=MULTI_ZONE_SUMMARY&unitId=${detail.data!.unitId}`),
    enabled: finished && Boolean(detail.data?.unitId),
    refetchInterval: (query) =>
      (query.state.data?.data ?? []).some((row) => row.status === 'QUEUED' || row.status === 'RENDERING') ? 4_000 : false,
  });
  const generateSummary = useMutation({
    mutationFn: (selectedZoneIds: string[]) =>
      api.post<ReportSnapshot>('/reports/generate', {
        kind: 'MULTI_ZONE_SUMMARY',
        unitId: detail.data!.unitId,
        selectedZoneIds,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reports', 'audit', auditId] }),
  });

  const open = async (snapshot: ReportSnapshot) => {
    setOpening(snapshot.id);
    setOpenError(null);
    try {
      const link = await api.get<ReportDownloadUrl>(`/reports/${snapshot.id}/download-url`);
      await Linking.openURL(link.url);
    } catch (error) {
      setOpenError(error);
    } finally {
      setOpening(null);
    }
  };

  if (detail.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.ink} />
      </Screen>
    );
  }
  if (!detail.data) {
    return (
      <Screen>
        <EmptyState title="Audit not available" detail={problemMessage(detail.error) ?? undefined} />
      </Screen>
    );
  }

  const audit = detail.data;
  const band = bandOf(audit.totals.scorePercentage);

  return (
    <Screen>
      <Stack.Screen options={{ title: audit.unitName }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Card>
          <CardHeader
            title={AUDIT_TYPE_LABELS[audit.auditType]}
            description={`By ${audit.auditorName}`}
            action={<Chip tone={AUDIT_STATUS_TONE[audit.status]}>{AUDIT_STATUS_LABELS[audit.status]}</Chip>}
          />
          <LedgerRow label="Started" value={audit.startedAt ? formatDateTime(audit.startedAt) : '—'} />
          <LedgerRow label="Completed" value={audit.completedAt ? formatDateTime(audit.completedAt) : '—'} />
          <LedgerRow
            label="Location"
            value={audit.startLatitude === null ? 'Not recorded' : audit.locationSuspicious ? 'Recorded, check it' : 'Recorded'}
            last
          />
        </Card>

        {audit.scored && finished ? (
          <Card>
            <CardHeader
              title="Score"
              description="As the server computed it."
              action={band === 'none' ? null : <Chip tone={band}>{bandFor(audit.totals.scorePercentage)?.label}</Chip>}
            />
            <Figure band={band} size={33}>
              {formatPct(audit.totals.scorePercentage)}
            </Figure>
            <View style={styles.band}>
              <StatusBand band={band} />
            </View>
            <Button
              title="Section scores"
              variant="secondary"
              onPress={() => router.push({ pathname: '/audit/summary/[auditId]', params: { auditId } })}
            />
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Zones" description={audit.zones.length === 0 ? 'No Zones recorded yet.' : null} />
          {audit.zones.map((zone, index) => {
            const zoneBand = bandOf(zone.totals.scorePercentage);
            const reportable = finished && audit.scored && zone.status === 'COMPLETED';
            return (
              <View key={zone.id} style={[styles.item, index === audit.zones.length - 1 && styles.itemLast]}>
                <View style={styles.itemHead}>
                  <Text style={styles.itemTitle}>{zoneDisplayLabel(zone.zoneCodeSnapshot, zone.zoneNameSnapshot)}</Text>
                  {audit.scored && zone.status === 'COMPLETED' ? (
                    <Figure band={zoneBand} size={20}>
                      {formatPct(zone.totals.scorePercentage)}
                    </Figure>
                  ) : (
                    <Chip>{humanize(zone.status)}</Chip>
                  )}
                </View>
                {zone.zoneLeaderNameSnapshot ? <Data>Leader {zone.zoneLeaderNameSnapshot}</Data> : null}
                {reportable && mayGenerate ? (
                  <View style={styles.itemAction}>
                    <Button
                      title="Generate report"
                      variant="secondary"
                      busy={generate.isPending && generate.variables === zone.id}
                      onPress={() => generate.mutate(zone.id)}
                    />
                  </View>
                ) : null}
              </View>
            );
          })}
          <ErrorBanner message={problemMessage(generate.error)} />
        </Card>

        {finished ? (
          <Card>
            <CardHeader
              title="Reports"
              description={
                reports.data && reports.data.data.length === 0
                  ? 'None yet. Generate one from a Zone above.'
                  : 'Frozen snapshots: a new version never changes an old one.'
              }
            />
            {mayGenerate && audit.scored && audit.zones.some((zone) => zone.status === 'COMPLETED') ? (
              <View style={styles.itemAction}>
                <Button
                  title="Generate unit summary report"
                  variant="secondary"
                  busy={generateSummary.isPending}
                  onPress={() =>
                    generateSummary.mutate(
                      audit.zones.filter((zone) => zone.status === 'COMPLETED').map((zone) => zone.zoneId),
                    )
                  }
                />
                <ErrorBanner message={problemMessage(generateSummary.error)} />
              </View>
            ) : null}
            {reportRows(reports.data?.data, summaries.data?.data, audit).map((snapshot) => (
              <View key={snapshot.id} style={styles.item}>
                <View style={styles.itemHead}>
                  <Text style={styles.itemTitle}>
                    {REPORT_KIND[snapshot.kind]}, v{snapshot.version}
                  </Text>
                  <Chip tone={snapshot.status === 'READY' ? 'ok' : snapshot.status === 'FAILED' ? 'crit' : 'muted'}>
                    {humanize(snapshot.status)}
                  </Chip>
                </View>
                <Data>
                  {formatDateTime(snapshot.generatedAt)} by {snapshot.generatedByName}
                </Data>
                {snapshot.status === 'READY' ? (
                  <View style={styles.itemAction}>
                    <Button
                      title="Open PDF"
                      variant="secondary"
                      busy={opening === snapshot.id}
                      onPress={() => void open(snapshot)}
                    />
                  </View>
                ) : snapshot.failedReason ? (
                  <Muted>{snapshot.failedReason}</Muted>
                ) : null}
              </View>
            ))}
            <ErrorBanner message={problemMessage(openError)} />
          </Card>
        ) : null}

        {finished && audit.scored && can('audit', 'edit_after_completion') ? (
          <View style={styles.actions}>
            <Button
              title="Correct this audit"
              variant="secondary"
              onPress={() => router.push({ pathname: '/manage/audit-edit/[auditId]', params: { auditId } })}
            />
            <Muted>Every change to a completed audit needs a reason and is kept in the activity log.</Muted>
          </View>
        ) : !finished && audit.status !== 'CANCELLED' ? (
          <Muted>
            Running on {audit.auditorName}'s phone. Scores and reports appear once it is completed.
          </Muted>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { paddingBottom: theme.space.xl },
  band: { marginTop: 10, marginBottom: theme.space.md },
  item: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.color.edgeSoft, gap: 2 },
  itemLast: { borderBottomWidth: 0, paddingBottom: 0 },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.space.sm },
  itemTitle: { flexShrink: 1, fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
  itemAction: { marginTop: theme.space.sm },
  actions: { gap: theme.space.sm, marginTop: theme.space.sm },
}));

/**
 * This audit's reports plus the zone summary reports that include one of its Zones, newest
 * first and each once.
 */
function reportRows(
  own: readonly ReportSnapshot[] | undefined,
  summaries: readonly ReportSnapshot[] | undefined,
  audit: AuditDetail,
): ReportSnapshot[] {
  const zoneIds = new Set(audit.zones.map((zone) => zone.zoneId));
  const rows = new Map<string, ReportSnapshot>();
  for (const snapshot of own ?? []) rows.set(snapshot.id, snapshot);
  for (const snapshot of summaries ?? []) {
    if ((snapshot.selectedZoneIds ?? []).some((id) => zoneIds.has(id))) rows.set(snapshot.id, snapshot);
  }
  return [...rows.values()].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}
