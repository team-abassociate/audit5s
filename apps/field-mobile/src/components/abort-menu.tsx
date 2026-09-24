import { Alert, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { HeaderAction } from './ui';
import { pauseLocalAudit, withdrawLocalZone } from '../lib/db/audit.repository';
import { useLocalDatabase } from '../lib/db/provider';
import { leaveScreen } from '../lib/leave-screen';
import { useSync } from '../lib/sync/provider';
import { useTheme } from '../lib/theme';

/**
 * The two ways out of a Zone, in its header, within a thumb of the questions.
 *
 *   - **Pause** — a break, not a decision. Everything is saved, the audit is paused and the
 *     auditor is taken out of it; *Resume* on Overview, or on the audit's Zones, brings them
 *     back to the question they stopped on.
 *   - **Abort** — this Zone only, never the audit (product owner, 2026-09-24). The Zone's
 *     answers are cleared from the audit: it leaves the score and what *Finish audit* waits
 *     for, and the same Zone can be started again from scratch, as a fresh Zone. The audit
 *     and its other Zones carry on. Nothing is deleted: what was recorded stays on record,
 *     marked withdrawn (A-1). A finished Zone offers no Abort — it is part of the audit,
 *     and changing it is a review.
 *
 * Abort asks first, and says what it will and will not do; Pause does not, because nothing
 * about a pause needs undoing.
 */
export function useAbortMenu({
  auditId,
  auditZoneId,
  zoneLabel,
  zoneFinished,
}: {
  auditId: string | undefined;
  auditZoneId: string;
  zoneLabel: string;
  zoneFinished: boolean;
}) {
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { sync } = useSync();
  const theme = useTheme();

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['local'] });
    // Told to the server as soon as there is signal, so the Zone is freed for others.
    void sync();
  };

  const abortZone = useMutation({
    mutationFn: () => withdrawLocalZone(database, auditZoneId, 'Aborted by auditor'),
    // Back to the audit's Zones, where the next Zone — or this one again — is started.
    onSuccess: () => leaveScreen(() => router.back(), refresh),
  });

  // No reason recorded, so the Super Admin reads it as a pause rather than an abort.
  const pause = useMutation({
    mutationFn: () => pauseLocalAudit(database, auditId!, null),
    onSuccess: () => leaveScreen(() => router.navigate('/overview'), refresh),
  });

  const pauseAudit = () => {
    if (auditId && !pause.isPending) pause.mutate();
  };

  const confirmAbort = () =>
    Alert.alert(
      `Abort ${zoneLabel}?`,
      'The answers and photographs of this Zone are cleared from the audit and it leaves ' +
        'the score. The audit and its other Zones are not affected, and you can start this ' +
        'Zone again from the beginning.',
      [
        { text: 'Keep auditing', style: 'cancel' },
        { text: 'Abort this Zone', style: 'destructive', onPress: () => abortZone.mutate() },
      ],
    );

  // Pause before Abort, on one line: the everyday way out first, the one that ends
  // something in the crit colour.
  const trigger = auditId ? (
    <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
      <HeaderAction
        testID="pause-audit"
        title="Pause"
        accessibilityLabel="Pause the audit. Everything is saved on this device, and you can resume it."
        onPress={pauseAudit}
        disabled={pause.isPending}
      />
      {zoneFinished ? null : (
        <HeaderAction
          testID="abort-zone"
          title="Abort"
          variant="danger"
          accessibilityLabel={`Abort ${zoneLabel}. The rest of the audit carries on.`}
          onPress={confirmAbort}
        />
      )}
    </View>
  ) : null;

  // Kept for the screens that mount it: the confirmation is now a system dialog.
  const sheet = null;

  return { trigger, sheet, busy: abortZone.isPending || pause.isPending, pauseAudit };
}
