import { useState } from 'react';
import { Alert, FlatList, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { formatDayMonth, zoneDisplayLabel } from '@audit5s/domain';
import {
  ActionBar,
  Button,
  Card,
  CardHeader,
  Chip,
  Data,
  EmptyState,
  ErrorBanner,
  Field,
  Muted,
  Screen,
  Segmented,
  SelectField,
} from '../../components/ui';
import { crossAuditAssignee } from '../../components/cross-audit-calls';
import {
  BOARD_STATE,
  auditorOptions,
  pickDueDate,
  roundClosed,
  roundDue,
  useCrossAuditRounds,
  useCrossAuditors,
  type RoundBoard,
} from '../../components/cross-audit-round';
import { api, problemMessage } from '../../lib/api';
import { isOverdue } from '../../lib/cross-audit-call';
import { useSession } from '../../lib/session';
import { createThemedStyles } from '../../lib/theme';

// The Audits tab's order.
const BOARDS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'DONE', label: 'Completed' },
  { value: 'ASSIGNED', label: 'Assigned' },
] as const;

const EMPTY: Record<RoundBoard, string> = {
  ASSIGNED: 'Every Zone has been started.',
  ACTIVE: 'No Zone is being audited right now.',
  DONE: 'No Zone has been audited yet.',
};

/**
 * One called cross audit (0051): its Zones on the board it was opened from — not started,
 * under way, done — and, for the Coordinator, the two things they do with it: move the
 * deadline when the Zone Leaders cannot make it, and complete it. Completing it with a Zone
 * not audited asks why; the remark is kept with it. Only a cross audit completes this way —
 * an external audit the Super Admin assigned is never here.
 */
export default function CrossAuditRoundScreen() {
  const styles = useStyles();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ roundId: string; board?: RoundBoard }>();
  const { scope, can, user } = useSession();
  const unitId = scope?.unitIds[0];
  const rounds = useCrossAuditRounds(unitId);
  const round = rounds.data?.find((one) => one.id === params.roundId);
  const [board, setBoard] = useState<RoundBoard>(params.board && params.board in BOARD_STATE ? params.board : 'ACTIVE');
  const [completing, setCompleting] = useState(false);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);

  const mayManage = can('unit', 'call_cross_audit') && round !== undefined && round.completedAt === null;
  const auditors = useCrossAuditors(unitId, mayManage);
  const left = round?.zones.filter((zone) => zone.state !== 'COMPLETED').length ?? 0;
  const shown = round?.zones.filter((zone) => zone.state === BOARD_STATE[board]) ?? [];
  const path = `/units/${unitId}/cross-audits/${params.roundId}`;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['cross-audits', unitId] });
  const fail = (title: string) => (error: unknown) => {
    setBusy(false);
    Alert.alert(title, problemMessage(error) ?? 'Try again.');
  };

  const extend = () =>
    pickDueDate(round!.dueOn, (dueOn) => {
      setBusy(true);
      api.patch(path, { dueOn }).then(() => {
        setBusy(false);
        void refresh();
        Alert.alert('Deadline moved', `The cross audit is now due by ${formatDayMonth(`${dueOn}T12:00:00+05:30`)}.`);
      }, fail('Could not move the deadline'));
    });

  // R-73: a Zone nobody has started goes to someone else; only they are told.
  const reassign = (zone: { zoneId: string; zoneCode: string; zoneName: string }, auditorUserId: string) => {
    const who = auditors.data?.find((auditor) => auditor.userId === auditorUserId)?.fullName ?? 'them';
    const what = zoneDisplayLabel(zone.zoneCode, zone.zoneName);
    Alert.alert(`Give ${what} to ${who}?`, `${who} is told to audit it by the deadline.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Change auditor',
        onPress: () => {
          setBusy(true);
          api.put(`${path}/zones/${zone.zoneId}/assignee`, { auditorUserId }).then(() => {
            setBusy(false);
            void refresh();
          }, fail('Could not change the auditor'));
        },
      },
    ]);
  };

  const complete = () => {
    setBusy(true);
    api.post(`${path}/complete`, remark.trim() ? { remark: remark.trim() } : {}).then(() => {
      setBusy(false);
      setCompleting(false);
      void refresh();
    }, fail('Could not complete the cross audit'));
  };

  const head = round ? (
    <>
      <Card rail={!roundClosed(round) && isOverdue(round) ? 'crit' : 'none'}>
        <CardHeader
          title={`${round.zones.length} Zone${round.zones.length === 1 ? '' : 's'}`}
          description={`Called ${formatDayMonth(round.createdAt)} by ${round.calledBy}`}
          action={round.completedAt ? <Chip>Completed</Chip> : undefined}
        />
        <Data>{roundDue(round)}</Data>
        {round.completedAt ? (
          <>
            <Data>{`Completed ${formatDayMonth(round.completedAt)} by ${round.completedBy ?? 'the Coordinator'}`}</Data>
            {round.completionRemark ? <Muted>{`Remark: ${round.completionRemark}`}</Muted> : null}
          </>
        ) : null}
      </Card>
      <Segmented
        options={BOARDS.map((option) => ({
          value: option.value,
          label: `${option.label} · ${round.zones.filter((zone) => zone.state === BOARD_STATE[option.value]).length}`,
        }))}
        value={board}
        onChange={setBoard}
      />
    </>
  ) : null;

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Cross-zonal audit' }} />
      <ErrorBanner message={rounds.error ? 'The cross audit could not load. This needs a connection.' : null} />
      <FlatList
        data={shown}
        keyExtractor={(zone) => zone.zoneId}
        ListHeaderComponent={head}
        refreshing={rounds.isRefetching}
        onRefresh={() => void rounds.refetch()}
        renderItem={({ item }) => (
          <Card
            accessibilityRole={item.auditId ? 'button' : undefined}
            onPress={
              item.auditId
                ? () => router.push({ pathname: '/manage/audit/[auditId]', params: { auditId: item.auditId! } })
                : undefined
            }
          >
            <Text style={styles.zone}>{zoneDisplayLabel(item.zoneCode, item.zoneName)}</Text>
            <Muted>{item.auditorName ? `Audited by ${item.auditorName}` : 'Nobody has started it'}</Muted>
            {crossAuditAssignee(item, user?.id) ? <Muted>{crossAuditAssignee(item, user?.id)}</Muted> : null}
            {mayManage && item.state === 'NOT_STARTED' ? (
              <SelectField
                label="Change auditor"
                placeholder="Choose who audits it"
                options={auditorOptions(auditors.data)}
                value={item.assigneeUserId ?? null}
                onChange={(userId) => userId !== item.assigneeUserId && reassign(item, userId)}
                searchable={(auditors.data?.length ?? 0) > 8}
              />
            ) : null}
          </Card>
        )}
        ListEmptyComponent={round ? <EmptyState title="Nothing here" detail={EMPTY[board]} /> : null}
      />
      {mayManage ? (
        <ActionBar>
          {completing ? (
            <View style={styles.form}>
              {left > 0 ? (
                <Field
                  label={`Why complete it with ${left} Zone${left === 1 ? '' : 's'} not audited?`}
                  value={remark}
                  onChangeText={setRemark}
                  multiline
                  maxLength={2000}
                  placeholder="e.g. Zone 25 shut for maintenance"
                />
              ) : (
                <Muted>Every Zone is audited. Completing closes the cross audit.</Muted>
              )}
              <View style={styles.row}>
                <View style={styles.item}>
                  <Button title="Back" icon="close" variant="secondary" onPress={() => setCompleting(false)} />
                </View>
                <View style={styles.item}>
                  <Button title="Complete" icon="check" busy={busy} disabled={left > 0 && !remark.trim()} onPress={complete} />
                </View>
              </View>
            </View>
          ) : (
            <View style={styles.row}>
              <View style={styles.item}>
                <Button title="Extend deadline" icon="event" variant="secondary" busy={busy} onPress={extend} />
              </View>
              <View style={styles.item}>
                <Button title="Complete" icon="done-all" onPress={() => setCompleting(true)} />
              </View>
            </View>
          )}
        </ActionBar>
      ) : null}
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  form: { gap: theme.space.sm },
  zone: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  row: { flexDirection: 'row', gap: theme.space.sm },
  item: { flex: 1 },
}));
