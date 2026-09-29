import { useMemo, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Audit, AuditDetail, Page, ReportSnapshot } from '@audit5s/contracts';
import { isAuditCompleted, reportZoneLabel } from '@audit5s/domain';
import { Button, CheckRow, Data, ErrorBanner, Muted } from './ui';
import { api, problemMessage } from '../lib/api';
import { formatDate, formatDateTime, formatPct } from '../lib/format';
import { createThemedStyles, useTheme } from '../lib/theme';

/**
 * The unit summary's selection on the phone, one audited Zone at a time.
 *
 * A Unit is often audited more than once on the same day — a team audit, or a second walk
 * after lunch — and the summary a Super Admin wants is those Zones together, not "every Zone
 * of the audit I happened to open". So this lists every finished audit of the Unit finished
 * on the same calendar day as `day`, each with its finished Zones, and sends exactly the
 * audited Zones ticked (`selectedAuditZoneIds`). Nothing is ticked to begin with.
 */
export function SummaryZonePicker({
  unitId,
  day,
  onQueued,
}: {
  unitId: string;
  /** Any instant on the day to summarise — the opened audit's `completedAt`. */
  day: string;
  onQueued?: (snapshot: ReportSnapshot) => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<string[]>([]);

  const audits = useQuery({
    queryKey: ['audits', 'unit', unitId],
    queryFn: () => api.get<Page<Audit>>(`/audits?limit=200&unitId=${unitId}`),
  });

  // Finished, scored audits of this Unit finished on the same day — a summary states
  // scores, an open audit's are still moving, and a walk-by has none. Earliest first, the
  // order the day happened in.
  const sameDay = useMemo(
    () =>
      (audits.data?.data ?? [])
        .filter(
          (audit) =>
            audit.unitId === unitId &&
            audit.scored &&
            isAuditCompleted(audit.status) &&
            audit.completedAt !== null &&
            dayKey(audit.completedAt) === dayKey(day),
        )
        .sort((a, b) => a.completedAt!.localeCompare(b.completedAt!)),
    [audits.data, unitId, day],
  );

  const details = useQueries({
    queries: sameDay.map((audit) => ({
      queryKey: ['audit', audit.id],
      queryFn: () => api.get<AuditDetail>(`/audits/${audit.id}`),
    })),
  });

  /** Each audit's finished Zones — only those can be summarised. */
  const zonesByAudit = sameDay.map((audit, index) => ({
    audit,
    query: details[index],
    zones: (details[index]?.data?.zones ?? []).filter((zone) => zone.status === 'COMPLETED'),
  }));
  const allIds = zonesByAudit.flatMap((group) => group.zones.map((zone) => zone.id));
  const allChosen = allIds.length > 0 && allIds.every((id) => chosen.includes(id));

  const toggle = (ids: readonly string[], on: boolean) =>
    setChosen((current) => (on ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id))));

  const generate = useMutation({
    mutationFn: () =>
      api.post<ReportSnapshot>('/reports/generate', {
        kind: 'MULTI_ZONE_SUMMARY',
        unitId,
        selectedAuditZoneIds: chosen,
      }),
    onSuccess: (snapshot) => {
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
      setChosen([]);
      onQueued?.(snapshot);
    },
  });

  if (audits.isLoading) return <ActivityIndicator color={theme.color.ink} />;
  if (audits.error) return <ErrorBanner message={problemMessage(audits.error)} />;
  if (sameDay.length === 0) {
    return <Muted>No finished audit of this Unit on {formatDate(day)}. A summary is made from finished Zones.</Muted>;
  }

  const count = `${chosen.length} Zone${chosen.length === 1 ? '' : 's'}`;

  return (
    <View style={styles.picker}>
      <Muted>
        {sameDay.length === 1 ? 'The audit' : `All ${sameDay.length} audits`} of this Unit finished on{' '}
        {formatDate(day)}. Tick the Zones the summary should cover; every figure in it is computed over those
        Zones only.
      </Muted>

      {allIds.length > 0 ? (
        <Button
          title={allChosen ? 'Clear all' : 'Choose all Zones'}
          variant="secondary"
          compact
          onPress={() => toggle(allIds, !allChosen)}
        />
      ) : null}

      {zonesByAudit.map(({ audit, query, zones }) => {
        const ids = zones.map((zone) => zone.id);
        const every = ids.length > 0 && ids.every((id) => chosen.includes(id));
        return (
          <View key={audit.id} style={styles.group}>
            <View style={styles.groupHead}>
              <View style={styles.groupText}>
                <Text style={styles.groupTitle}>{audit.auditorName}</Text>
                <Data>
                  Finished {formatDateTime(audit.completedAt!)} · {zones.length} Zone{zones.length === 1 ? '' : 's'}
                </Data>
              </View>
              {ids.length > 1 ? (
                <Button
                  title={every ? 'None' : 'All'}
                  variant="secondary"
                  compact
                  accessibilityLabel={`${every ? 'Untick' : 'Tick'} every Zone of ${audit.auditorName}'s audit`}
                  onPress={() => toggle(ids, !every)}
                />
              ) : null}
            </View>
            {query?.isLoading ? <ActivityIndicator color={theme.color.ink} /> : null}
            <ErrorBanner message={problemMessage(query?.error)} />
            {query?.data && zones.length === 0 ? <Muted>No finished Zone in this audit.</Muted> : null}
            {zones.map((zone) => (
              <CheckRow
                key={zone.id}
                // Named as the summary will name it: the auditor's own words for the Zone.
                label={reportZoneLabel({
                  zoneCode: zone.zoneCodeSnapshot,
                  zoneName: zone.zoneNameSnapshot,
                  zoneDescription: zone.zoneDescriptionSnapshot,
                })}
                detail={zone.zoneLeaderNameSnapshot ? `Leader ${zone.zoneLeaderNameSnapshot}` : null}
                value={formatPct(zone.totals.scorePercentage)}
                checked={chosen.includes(zone.id)}
                onChange={(on) => toggle([zone.id], on)}
              />
            ))}
          </View>
        );
      })}

      <Button
        title={chosen.length === 0 ? 'Tick at least one Zone' : `Generate summary of ${count}`}
        busy={generate.isPending}
        disabled={chosen.length === 0}
        onPress={() => generate.mutate()}
      />
      <ErrorBanner message={problemMessage(generate.error)} />
    </View>
  );
}

/** `2026-09-28`, in the phone's own calendar — the day an auditor would name. */
function dayKey(iso: string): string {
  const at = new Date(iso);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

const useStyles = createThemedStyles((theme) => ({
  picker: { gap: theme.space.sm },
  group: { gap: theme.space.sm, paddingTop: theme.space.sm, borderTopWidth: 1, borderTopColor: theme.color.edgeSoft },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.space.sm },
  groupText: { flexShrink: 1 },
  groupTitle: { fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
}));
