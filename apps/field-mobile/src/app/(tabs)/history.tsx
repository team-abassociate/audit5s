import { useCallback } from 'react';
import { SectionList, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Button, Card, CardHeader, Chip, Data, EmptyState, Screen, SectionHead } from '../../components/ui';
import { listLocalAudits, pendingOutboxCount } from '../../lib/db/audit.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { formatDateTime } from '../../lib/format';
import { AUDIT_STATUS_LABELS, AUDIT_STATUS_TONE, AUDIT_TYPE_LABELS, isFinished } from '../../lib/labels';
import { createThemedStyles } from '../../lib/theme';
import type { AuditStatus, AuditType } from '@audit5s/contracts';
import { flattenAuditGroups, groupAuditsByUnitAndZone, zoneDisplayLabel } from '@audit5s/domain';
import { GroupHeads, InZone } from '../../components/audit-groups';
import { SelfieChip, useSelfieStatuses } from '../../components/selfie-check';
import { ScorecardButton } from '../../components/scorecard-button';

type LocalAudit = Awaited<ReturnType<typeof listLocalAudits>>[number];

/** The card's title: what was audited, not the Unit every card on the phone shares. */
function zonesTitle(audit: LocalAudit): string {
  const zones = zonesOf(audit);
  return zones.length === 0 ? 'No Zone yet' : zones.map(([code, name]) => zoneDisplayLabel(code, name)).join(', ');
}

function zonesOf(audit: LocalAudit): [string, string][] {
  return JSON.parse(audit.zoneSnapshots || '[]') as [string, string][];
}

/**
 * Audit history — **this device's** audits, read from SQLite.
 *
 * It lists what the device authored rather than what the server holds, which is the honest
 * thing on a phone that may not have synced for a week: an audit finished in a plant with
 * no signal is history the moment it is finished, not when the server hears about it.
 *
 * §9.9 requires the UI never to say "saved" when it means "queued". The header says both,
 * separately.
 *
 * Nested like every audit list (owner, 2026-11-27): Unit, then Zone, newest first within each.
 */
export default function HistoryScreen() {
  const styles = useStyles();
  const database = useLocalDatabase();
  const router = useRouter();

  const audits = useQuery({
    queryKey: ['local', 'audits'],
    queryFn: () => listLocalAudits(database),
  });

  const pending = useQuery({
    queryKey: ['local', 'outbox-count'],
    queryFn: () => pendingOutboxCount(database),
  });
  const selfies = useSelfieStatuses();

  const renderItem = useCallback(
    ({ item }: { item: LocalAudit }) => (
      <InZone>
        <Card>
          <CardHeader
            title={zonesTitle(item)}
            description={`${AUDIT_TYPE_LABELS[item.auditType as AuditType] ?? item.auditType} · ${item.unitName ?? 'Unit'}`}
            action={
              <Chip tone={AUDIT_STATUS_TONE[item.status as AuditStatus] ?? 'muted'}>
                {AUDIT_STATUS_LABELS[item.status as AuditStatus] ?? item.status}
              </Chip>
            }
          />
          <Data>Updated {formatDateTime(item.clientUpdatedAt)}</Data>
          <SelfieChip status={selfies.data?.get(item.id)} />
          <View style={styles.actions}>
            {/*
              N6: a Consultant's read model, not a report. The official PDF is a Super
              Admin deliverable, and nothing on this device issues one.
            */}
            {isFinished(item.status) && item.auditType !== 'WALK_BY' ? (
              <View style={styles.action}>
                <Button icon="bar-chart"
                  title="Scores"
                  variant="secondary"
                  onPress={() =>
                    router.push({ pathname: '/audit/summary/[auditId]', params: { auditId: item.id } })
                  }
                />
              </View>
            ) : null}
            {isFinished(item.status) && item.auditType !== 'WALK_BY' ? (
              <View style={styles.action}>
                <ScorecardButton auditId={item.id} />
              </View>
            ) : null}
            <View style={styles.action}>
              <Button icon={isFinished(item.status) ? 'visibility' : 'play-arrow'}
                title={isFinished(item.status) ? 'Review' : 'Open'}
                variant="secondary"
                onPress={() =>
                  router.push({ pathname: '/audit/zones/[auditId]', params: { auditId: item.id } })
                }
              />
            </View>
          </View>
        </Card>
      </InZone>
    ),
    [styles, router, selfies.data],
  );

  return (
    <Screen>
      <SectionList
        sections={flattenAuditGroups(
          groupAuditsByUnitAndZone(audits.data ?? [], (audit) => ({
            unitId: audit.unitId,
            unitName: audit.unitName ?? 'Unit',
            zones: zonesOf(audit).map(([code, name]) => ({ key: code, code, name })),
          })),
        )}
        // An audit of two Zones is drawn under both, so its key carries its place.
        keyExtractor={(audit, index) => `${audit.id}:${index}`}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => <GroupHeads section={section} showUnit noun={['audit', 'audits']} />}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <SectionHead
            title="Audits on this device"
            description={
              pending.data === 0
                ? 'Everything on this device has been synced.'
                : `${pending.data ?? 0} item(s) saved on this device, waiting to sync.`
            }
          />
        }
        ListEmptyComponent={
          <EmptyState
            title="No audits yet"
            detail="Start an audit from Overview. Everything you record is kept on this device."
          />
        }
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  actions: { marginTop: theme.space.md, flexDirection: 'row', gap: theme.space.sm },
  action: { flex: 1 },
}));
