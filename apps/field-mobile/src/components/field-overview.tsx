import { RefreshControl, ScrollView, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import type { AuditStatus, AuditType } from '@audit5s/contracts';
import { awaitsResponse } from '@audit5s/domain';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Data,
  EmptyState,
  ErrorBanner,
  Muted,
  Screen,
  SectionHead,
  SlipStack,
  StatGrid,
} from './ui';
import { crossAuditCallZone, crossAuditStart, useOpenCrossAuditCalls } from './cross-audit-calls';
import { syncCatalogue } from '../lib/catalogue';
import {
  listLocalAudits,
  listResumableAudits,
  pendingOutboxCount,
  resumeCursor,
  resumeLocalAudit,
  type ResumableAudit,
} from '../lib/db/audit.repository';
import { listLocalCorrectiveActions } from '../lib/db/corrective-action.repository';
import { useLocalDatabase } from '../lib/db/provider';
import { formatDateTime } from '../lib/format';
import { AUDIT_STATUS_LABELS, AUDIT_STATUS_TONE, AUDIT_TYPE_LABELS, isFinished } from '../lib/labels';
import { useSession } from '../lib/session';
import { createThemedStyles, useTheme } from '../lib/theme';

/**
 * The Overview a Consultant gets — the field counterpart of the management board.
 *
 * It answers one question before any other: **what am I in the middle of?** An auditor who
 * paused in Zone 3 on Tuesday and opens the app on Wednesday should not have to remember
 * which Unit it was, find it in a list, open its Zones and read the banner. The audit is on
 * this device; the screen says so and offers the way back in.
 *
 * Everything on it is read from SQLite, so it is the same screen with the radio off. The
 * one network call is the catalogue pull, which is fire-and-forget and shares its key with
 * the Units tab so opening either one is the refresh R-28 promises — and opening both is
 * still one sync.
 */
export function FieldOverview() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const { user, scope } = useSession();
  // R-18: a Super Admin answers corrective actions too; a Consultant never does.
  const answersActions = scope?.role === 'ZONE_LEADER' || scope?.role === 'SUPER_ADMIN';
  // A Zone Leader has one Unit and no Units tab: their shortcut starts the audit itself.
  const zoneLeader = scope?.role === 'ZONE_LEADER';

  const resumable = useQuery({
    queryKey: ['local', 'resumable-audits'],
    queryFn: () => listResumableAudits(database),
  });

  const audits = useQuery({
    queryKey: ['local', 'audits'],
    queryFn: () => listLocalAudits(database),
  });

  const pending = useQuery({
    queryKey: ['local', 'outbox-count'],
    queryFn: () => pendingOutboxCount(database),
  });

  const actions = useQuery({
    queryKey: ['local', 'corrective-actions'],
    queryFn: () => listLocalCorrectiveActions(database),
    enabled: answersActions,
  });

  const crossAudit = useOpenCrossAuditCalls(zoneLeader);
  const crossAuditCalls = crossAudit.calls;

  const sync = useMutation({
    mutationFn: () => syncCatalogue(database),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['local'] }),
  });

  /**
   * Back into the audit, at the question it stopped on.
   *
   * A paused audit is resumed first — the status has to move before the questionnaire will
   * accept another answer — and then the cursor decides where to land: the Zone that was
   * open, or the Zone list when there is none, which is the case for an audit that was
   * started and never opened a Zone.
   */
  const resume = useMutation({
    mutationFn: async (audit: ResumableAudit) => {
      if (audit.status === 'PAUSED') {
        await resumeLocalAudit(database, audit.id);
      }
      return { audit, cursor: await resumeCursor(database, audit.id) };
    },
    onSuccess: async ({ audit, cursor }) => {
      await queryClient.invalidateQueries({ queryKey: ['local'] });
      if (cursor.auditZoneId) {
        router.push({
          pathname: audit.auditType === 'WALK_BY' ? '/walk-by/[auditZoneId]' : '/audit/[auditZoneId]',
          params: { auditZoneId: cursor.auditZoneId },
        });
        return;
      }
      router.push({ pathname: '/audit/zones/[auditId]', params: { auditId: audit.id } });
    },
  });

  const open = resumable.data ?? [];
  const finishedCount = (audits.data ?? []).filter((audit) => isFinished(audit.status)).length;
  const toDo = actions.data?.filter((action) => awaitsResponse(action.effectiveStatus)).length ?? 0;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={sync.isPending}
            onRefresh={() => {
              sync.mutate();
              void crossAudit.notifications.refetch();
            }}
            colors={[theme.color.ink]}
            progressBackgroundColor={theme.color.tile}
          />
        }
      >
        <ErrorBanner
          message={
            sync.error
              ? 'Could not refresh. Everything below is stored on this device; pull down to try again.'
              : null
          }
        />

        <SectionHead
          title={user ? `Good to see you, ${firstName(user.fullName)}` : 'Your work'}
          description={
            open.length === 0
              ? 'Nothing in progress.'
              : `${open.length} audit${open.length === 1 ? '' : 's'} open on this device.`
          }
        />

        {/* The one slip: findings to answer, and a cross audit called at their Unit. */}
        <SlipStack
          rows={[
            ...(answersActions && toDo > 0
              ? [
                  {
                    tone: 'slip' as const,
                    title: `${toDo} nonconformit${toDo === 1 ? 'y' : 'ies'} waiting for you`,
                    detail: 'Fix with a photo, or explain why not.',
                    onPress: () => router.push('/actions'),
                  },
                ]
              : []),
            // One call starts its audit; several open the list, each needing its own audit.
            ...(crossAuditCalls.length === 1
              ? [
                  {
                    tone: 'crossAudit' as const,
                    title: `Cross audit called · ${crossAuditCallZone(crossAuditCalls[0]!)}`,
                    detail: `At ${String(crossAuditCalls[0]!.data.unitName ?? 'your Unit')}. Tap to start it.`,
                    onPress: () => router.push(crossAuditStart(crossAuditCalls[0]!)),
                  },
                ]
              : crossAuditCalls.length > 1
                ? [
                    {
                      tone: 'crossAudit' as const,
                      title: `${crossAuditCalls.length} cross audits called`,
                      detail: 'Each Zone needs its own audit.',
                      onPress: () => router.push('/cross-audits'),
                    },
                  ]
                : []),
          ]}
        />

        {open.length === 0 ? (
          <Card>
            <EmptyState
              title="No audit in progress"
              detail="When you start one it appears here, with the way back to the question you stopped on."
            />
            <Button
              testID="open-field-unit"
              title="Start an audit"
              variant="secondary"
              onPress={() => router.push('/audit/start')}
            />
          </Card>
        ) : (
          open.map((audit) => (
            <Card key={audit.id} rail={audit.status === 'PAUSED' ? 'warn' : 'none'}>
              <CardHeader
                title={audit.unitName ?? 'Unit'}
                description={AUDIT_TYPE_LABELS[audit.auditType as AuditType] ?? audit.auditType}
                action={
                  <Chip tone={AUDIT_STATUS_TONE[audit.status as AuditStatus] ?? 'muted'}>
                    {AUDIT_STATUS_LABELS[audit.status as AuditStatus] ?? audit.status}
                  </Chip>
                }
              />
              <Data>
                {audit.zonesTotal === 0
                  ? 'No Zone started yet'
                  : `${audit.zonesFinished} of ${audit.zonesTotal} Zone${audit.zonesTotal === 1 ? '' : 's'} finished`}
              </Data>
              <Data>Last worked on {formatDateTime(audit.clientUpdatedAt)}</Data>
              {/* N7: the reason an abort recorded, read back to the person who wrote it. */}
              {audit.pauseReason ? <Muted>{audit.pauseReason}</Muted> : null}
              <View style={styles.actions}>
                <View style={styles.action}>
                  <Button
                    title={audit.status === 'PAUSED' ? 'Resume' : 'Continue'}
                    busy={resume.isPending && resume.variables?.id === audit.id}
                    onPress={() => resume.mutate(audit)}
                  />
                </View>
                <View style={styles.action}>
                  <Button
                    title="Zones"
                    variant="secondary"
                    onPress={() =>
                      router.push({
                        pathname: '/audit/zones/[auditId]',
                        params: { auditId: audit.id },
                      })
                    }
                  />
                </View>
              </View>
            </Card>
          ))
        )}

        <View style={styles.section}>
          <SectionHead title="This device" />
          <StatGrid
            items={[
              { label: 'Open', value: String(open.length) },
              { label: 'Finished', value: String(finishedCount) },
              // §9.9's honest wording: queued is not saved-on-the-server.
              { label: 'To sync', value: String(pending.data ?? 0) },
            ]}
          />
          <View style={styles.actions}>
            <View style={styles.action}>
              <Button title="History" variant="secondary" onPress={() => router.push('/history')} />
            </View>
            <View style={styles.action}>
              <Button
                testID="field-units-shortcut"
                title={zoneLeader ? 'Start an audit' : 'Units'}
                variant="secondary"
                onPress={() => router.push(zoneLeader ? '/audit/start' : '/')}
              />
            </View>
          </View>
        </View>

        <Muted>
          Everything here is stored on this device. Nothing waits for a connection, and
          nothing is lost without one.
        </Muted>
      </ScrollView>
    </Screen>
  );
}

/** "Priya Nair" → "Priya". A greeting uses one name; the Profile tab has the whole one. */
function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.xl },
  section: { marginTop: theme.space.lg },
  actions: { marginTop: theme.space.md, flexDirection: 'row', gap: theme.space.sm },
  action: { flex: 1 },
}));
