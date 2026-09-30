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
  ConfirmAction,
  Data,
  EmptyState,
  ErrorBanner,
  Figure,
  LedgerRow,
  Muted,
  Screen,
  StatusBand,
} from '../../../components/ui';
import { SummaryZonePicker } from '../../../components/summary-zone-picker';
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
  // R-24: a Coordinator reads audits; generating and correcting are the Super Admin's.
  // R-39: and the reports are not the Coordinator's at all, so the card is not shown.
  const { can } = useSession();
  const mayGenerate = can('report', 'generate');
  const mayReadReports = can('report', 'read_snapshot');

  const detail = useQuery({ queryKey: ['audit', auditId], queryFn: () => api.get<AuditDetail>(`/audits/${auditId}`) });
  const finished = detail.data ? isFinished(detail.data.status) : false;
  const reports = useQuery({
    queryKey: ['reports', 'audit', auditId],
    queryFn: () => api.get<Page<ReportSnapshot>>(`/reports?limit=50&auditId=${auditId}`),
    enabled: finished && mayReadReports,
    // A queued report renders in the background; the list notices without a reload.
    refetchInterval: (query) =>
      (query.state.data?.data ?? []).some((row) => row.status === 'QUEUED' || row.status === 'RENDERING') ? 4_000 : false,
  });
  const generate = useMutation({
    mutationFn: (auditZoneId: string) => api.post<ReportSnapshot>('/reports/generate', { kind: 'INITIAL_ZONE', auditZoneId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reports', 'audit', auditId] }),
  });
  // Cancel a report still in the queue; delete (remove) one rendered or failed. Both take it
  // out of the list; a deleted one's PDF is gone for good (0035).
  const withdraw = useMutation({
    mutationFn: (snapshot: ReportSnapshot) =>
      api.post<ReportSnapshot>(`/reports/${snapshot.id}/${inFlight(snapshot) ? 'cancel' : 'remove'}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reports'] }),
  });
  // The zone summary report (`MULTI_ZONE_SUMMARY`) spans Zones rather than one audit, so its
  // snapshots carry no audit of their own: they are listed from the Unit, and the ones that
  // include a Zone of this audit are shown here.
  const summaries = useQuery({
    queryKey: ['reports', 'audit', auditId, 'summaries', detail.data?.unitId],
    queryFn: () =>
      api.get<Page<ReportSnapshot>>(`/reports?limit=50&kind=MULTI_ZONE_SUMMARY&unitId=${detail.data!.unitId}`),
    enabled: finished && mayReadReports && Boolean(detail.data?.unitId),
    refetchInterval: (query) =>
      (query.state.data?.data ?? []).some((row) => row.status === 'QUEUED' || row.status === 'RENDERING') ? 4_000 : false,
  });
  // The unit summary is chosen Zone by Zone from every audit of this Unit finished the same
  // day as this one; the picker opens in place.
  const [summaryOpen, setSummaryOpen] = useState(false);

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
          <LedgerRow label="Completed" value={audit.completedAt ? formatDateTime(audit.completedAt) : '—'} last />
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
                      // One request at a time: a second tap while the first is in flight
                      // is how a report came to be queued twice.
                      disabled={generate.isPending}
                      onPress={() => generate.mutate(zone.id)}
                    />
                  </View>
                ) : null}
              </View>
            );
          })}
          <ErrorBanner message={problemMessage(generate.error)} />
        </Card>

        {finished && mayReadReports ? (
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
                  title={summaryOpen ? 'Close unit summary' : 'Generate unit summary report'}
                  variant="secondary"
                  onPress={() => setSummaryOpen((isOpen) => !isOpen)}
                />
                {summaryOpen && audit.completedAt ? (
                  <View style={styles.itemAction}>
                    <SummaryZonePicker
                      unitId={audit.unitId}
                      day={audit.completedAt}
                      onQueued={() => setSummaryOpen(false)}
                    />
                  </View>
                ) : null}
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
                {mayGenerate ? (
                  <View style={styles.itemAction}>
                    {inFlight(snapshot) ? (
                      <Button
                        title="Cancel"
                        variant="danger"
                        busy={withdraw.isPending && withdraw.variables?.id === snapshot.id}
                        onPress={() => withdraw.mutate(snapshot)}
                      />
                    ) : (
                      <ConfirmAction
                        compact
                        title="Delete"
                        question={`Delete ${REPORT_KIND[snapshot.kind]} v${snapshot.version}? It leaves every list and its PDF is deleted. This cannot be undone.`}
                        confirmLabel="Delete report"
                        busy={withdraw.isPending && withdraw.variables?.id === snapshot.id}
                        onConfirm={() => withdraw.mutate(snapshot)}
                      />
                    )}
                  </View>
                ) : null}
              </View>
            ))}
            <ErrorBanner message={problemMessage(openError)} />
            <ErrorBanner message={problemMessage(withdraw.error)} />
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
            Running on {audit.auditorName}'s phone.{' '}
            {mayReadReports ? 'Scores and reports appear' : 'Scores appear'} once it is completed.
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

/** Queued or rendering: cancellable, not yet a document. */
function inFlight(snapshot: ReportSnapshot): boolean {
  return snapshot.status === 'QUEUED' || snapshot.status === 'RENDERING';
}

/**
 * This audit's reports plus the zone summary reports that include one of its Zones (by the
 * audited Zone where the summary names those, else by the Zone), newest
 * first and each once.
 */
function reportRows(
  own: readonly ReportSnapshot[] | undefined,
  summaries: readonly ReportSnapshot[] | undefined,
  audit: AuditDetail,
): ReportSnapshot[] {
  const zoneIds = new Set(audit.zones.map((zone) => zone.zoneId));
  const auditZoneIds = new Set(audit.zones.map((zone) => zone.id));
  const rows = new Map<string, ReportSnapshot>();
  for (const snapshot of own ?? []) rows.set(snapshot.id, snapshot);
  for (const snapshot of summaries ?? []) {
    const included = snapshot.selectedAuditZoneIds
      ? snapshot.selectedAuditZoneIds.some((id) => auditZoneIds.has(id))
      : (snapshot.selectedZoneIds ?? []).some((id) => zoneIds.has(id));
    if (included) rows.set(snapshot.id, snapshot);
  }
  return [...rows.values()].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}
