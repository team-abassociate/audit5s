import { useState } from 'react';
import { ActivityIndicator, Image, ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { CorrectiveActionDetail, EvidenceViewUrl } from '@audit5s/contracts';
import { awaitsResponse, awaitsReview, isOverdue, sectionLabel } from '@audit5s/domain';
import {
  Button,
  Card,
  CardHeader,
  Chip,
  Data,
  EmptyState,
  ErrorBanner,
  Field,
  Label,
  Muted,
  Screen,
} from '../../../components/ui';
import { api, problemMessage } from '../../../lib/api';
import { formatDate, formatDateTime } from '../../../lib/format';
import { humanize } from '../../../lib/labels';
import { useSession } from '../../../lib/session';
import { createThemedStyles, useTheme } from '../../../lib/theme';

/**
 * Reviewing one corrective action: the finding and its before photo, the latest response and
 * its after photo, then Verify or Reopen. Reopening needs a reason, which the Zone leader
 * reads; both carry the version read, so a second reviewer gets VERSION_CONFLICT (§15.8).
 *
 * A Coordinator (R-24) reads it: verifying, reopening and answering are not the role's (§6.3),
 * so those controls are not shown.
 */
export default function ReviewActionScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const { actionId } = useLocalSearchParams<{ actionId: string }>();
  const [note, setNote] = useState('');
  const mayReview = can('corrective_action', 'verify');
  const mayAnswer = can('corrective_action', 'submit');

  const detail = useQuery({
    queryKey: ['corrective-action', actionId],
    queryFn: () => api.get<CorrectiveActionDetail>(`/corrective-actions/${actionId}`),
  });

  const review = useMutation({
    mutationFn: (outcome: 'verify' | 'reopen') =>
      api.post<CorrectiveActionDetail>(
        `/corrective-actions/${actionId}/${outcome}`,
        outcome === 'verify'
          ? { version: detail.data!.version, ...(note.trim() ? { comment: note.trim() } : {}) }
          : { version: detail.data!.version, reason: note.trim() },
      ),
    onSuccess: async () => {
      setNote('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['corrective-action', actionId] }),
        queryClient.invalidateQueries({ queryKey: ['corrective-actions'] }),
        queryClient.invalidateQueries({ queryKey: ['audits'] }),
      ]);
    },
  });

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
        <EmptyState title="Corrective action not available" detail={problemMessage(detail.error) ?? undefined} />
      </Screen>
    );
  }

  const action = detail.data;
  const latest = [...action.submissions].sort((a, b) => b.attemptNo - a.attemptNo)[0];
  const reviewing = awaitsReview(action.status);
  const late = isOverdue(action.status, action.dueAt, Date.now());

  return (
    <Screen>
      <Stack.Screen options={{ title: `Zone ${action.zoneCode}` }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card rail={late ? 'crit' : reviewing ? 'warn' : 'none'}>
          <CardHeader
            title={`Zone ${action.zoneCode} — ${action.zoneName}`}
            description={
              action.questionGlobalOrder
                ? `${action.section ? `${sectionLabel(action.section)} · ` : ''}Q${action.questionGlobalOrder}: ${action.questionText ?? ''}`
                : 'Walk-by observation'
            }
            action={
              <Chip tone={reviewing ? 'warn' : action.status === 'VERIFIED' ? 'ok' : action.status === 'REOPENED' ? 'crit' : 'muted'}>
                {humanize(action.status)}
              </Chip>
            }
          />
          {action.findingRemark ? (
            <View style={styles.block}>
              <Label>Finding</Label>
              <Text style={styles.body}>{action.findingRemark}</Text>
            </View>
          ) : null}
          <Label>Before</Label>
          <EvidenceImage evidenceId={action.evidenceId} label="Before photograph" />
          <Data>
            {[
              action.dueAt ? `Due ${formatDate(action.dueAt)}${late ? ', overdue' : ''}` : 'No due date',
              action.assignedZoneLeaderName ? `owner ${action.assignedZoneLeaderName}` : 'no owner',
              action.reopenCount > 0 ? `reopened ×${action.reopenCount}` : null,
            ]
              .filter(Boolean)
              .join(', ')}
          </Data>
        </Card>

        {latest ? (
          <Card>
            <CardHeader
              title={`Response, attempt ${latest.attemptNo}`}
              description={`${latest.option === 'COMPLETED' ? 'Fixed' : 'Not possible'}, by ${latest.submittedByName}, ${formatDateTime(latest.createdAt)}`}
              action={
                latest.reviewOutcome ? (
                  <Chip tone={latest.reviewOutcome === 'VERIFIED' ? 'ok' : 'crit'}>{humanize(latest.reviewOutcome)}</Chip>
                ) : null
              }
            />
            {latest.description ?? latest.explanation ? (
              <Text style={[styles.body, styles.block]}>{latest.description ?? latest.explanation}</Text>
            ) : null}
            {latest.afterEvidenceId ? (
              <>
                <Label>After</Label>
                <EvidenceImage evidenceId={latest.afterEvidenceId} label="After photograph" />
              </>
            ) : null}
            {latest.reviewComment ? <Muted>Review note: {latest.reviewComment}</Muted> : null}
          </Card>
        ) : (
          <Card>
            <Muted>No response yet.</Muted>
          </Card>
        )}

        {reviewing && mayReview ? (
          <Card>
            <CardHeader
              title="Your review"
              description="Verify closes it. Reopen sends it back to the Zone leader with your note."
            />
            <Field label="Note (required to reopen)" multiline value={note} onChangeText={setNote} />
            <ErrorBanner message={problemMessage(review.error)} />
            <View style={styles.row}>
              <View style={styles.rowItem}>
                <Button
                  title="Reopen"
                  variant="danger"
                  disabled={note.trim() === ''}
                  busy={review.isPending && review.variables === 'reopen'}
                  onPress={() => review.mutate('reopen')}
                />
              </View>
              <View style={styles.rowItem}>
                <Button
                  title="Verify"
                  busy={review.isPending && review.variables === 'verify'}
                  onPress={() => review.mutate('verify')}
                />
              </View>
            </View>
          </Card>
        ) : awaitsResponse(action.status) ? (
          <Card>
            <CardHeader
              title="Waiting for a response"
              description="Whoever holds the report link can answer it, as can a Super Admin."
            />
            {mayAnswer ? (
              <Button
                title="Respond from this phone"
                variant="secondary"
                onPress={() => router.push({ pathname: '/actions/[actionId]', params: { actionId: action.id } })}
              />
            ) : null}
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function EvidenceImage({ evidenceId, label }: { evidenceId: string; label: string }) {
  const styles = useStyles();
  const view = useQuery({
    queryKey: ['evidence-view-url', evidenceId],
    queryFn: () => api.get<EvidenceViewUrl>(`/evidence/${evidenceId}/view-url?variant=thumbnail`),
    staleTime: 240_000,
    retry: false,
  });
  return view.data ? (
    <Image source={{ uri: view.data.url }} style={styles.photo} accessibilityLabel={label} />
  ) : (
    <View style={styles.placeholder}>
      <Muted>{view.isLoading ? 'Loading the photograph…' : 'The photograph could not load.'}</Muted>
    </View>
  );
}

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { paddingBottom: theme.space.xl },
  block: { marginBottom: theme.space.md },
  body: { fontFamily: theme.family.regular, fontSize: theme.font.base, lineHeight: 22, color: theme.color.ink },
  photo: {
    width: '100%',
    aspectRatio: 4 / 3,
    marginBottom: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile2,
  },
  placeholder: {
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: theme.space.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.color.edge,
    backgroundColor: theme.color.tile2,
  },
  row: { flexDirection: 'row', gap: theme.space.sm },
  rowItem: { flex: 1 },
}));
