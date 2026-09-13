import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { AuditDetail, ResponseValue } from '@audit5s/contracts';
import { zoneDisplayLabel } from '@audit5s/domain';
import { ResponseChips } from '../../../components/response-chips';
import {
  ActionBar,
  Button,
  Card,
  ChoiceList,
  EmptyState,
  ErrorBanner,
  Field,
  Screen,
  SectionHead,
} from '../../../components/ui';
import { api, problemMessage } from '../../../lib/api';
import { listLocalQuestions } from '../../../lib/db/catalogue.repository';
import { useLocalDatabase } from '../../../lib/db/provider';
import { createThemedStyles, useTheme } from '../../../lib/theme';

/**
 * Correcting a completed audit — `PATCH /audits/{id}/post-completion`, the only way one
 * changes (A-2). The reason is required and lands in the activity log with the before and
 * after, and the server recomputes every score. The question wording comes from this phone's
 * copy of the checklist.
 */
export default function EditAuditScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const database = useLocalDatabase();
  const { auditId } = useLocalSearchParams<{ auditId: string }>();
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, ResponseValue>>({});
  const [remark, setRemark] = useState('');
  const [justification, setJustification] = useState('');

  const detail = useQuery({ queryKey: ['audit', auditId], queryFn: () => api.get<AuditDetail>(`/audits/${auditId}`) });
  const zones = useMemo(() => (detail.data?.zones ?? []).filter((zone) => zone.status === 'COMPLETED'), [detail.data]);
  const zone = zones.find((candidate) => candidate.id === zoneId) ?? null;

  useEffect(() => {
    if (zoneId === null && zones.length === 1) setZoneId(zones[0]!.id);
  }, [zoneId, zones]);
  useEffect(() => {
    setChanges({});
    setRemark(zone?.zoneRemark ?? '');
  }, [zone?.id, zone?.zoneRemark]);

  const questions = useQuery({
    queryKey: ['local', 'checklist-questions', zone?.checklistVersionId],
    queryFn: () => listLocalQuestions(database, zone!.checklistVersionId!),
    enabled: Boolean(zone?.checklistVersionId),
  });
  const byId = useMemo(() => new Map((questions.data ?? []).map((question) => [question.id, question])), [questions.data]);

  const changed = Object.entries(changes).filter(
    ([responseId, value]) => zone?.responses.find((response) => response.id === responseId)?.value !== value,
  );
  const remarkChanged = zone !== null && remark.trim() !== (zone.zoneRemark ?? '');
  const dirty = changed.length > 0 || remarkChanged;

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/audits/${auditId}/post-completion`, {
        justification: justification.trim(),
        changes: {
          ...(changed.length > 0
            ? { responses: changed.map(([responseId, value]) => ({ responseId, value })) }
            : {}),
          ...(remarkChanged && zone ? { zoneRemark: { auditZoneId: zone.id, remark: remark.trim() || null } } : {}),
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['audit', auditId] }),
        queryClient.invalidateQueries({ queryKey: ['audits'] }),
        queryClient.invalidateQueries({ queryKey: ['audit-summary', auditId] }),
      ]);
      router.back();
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
        <EmptyState title="Audit not available" detail={problemMessage(detail.error) ?? undefined} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Correct audit' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <SectionHead title="Zone" description="Only a completed Zone can be corrected." />
        <ChoiceList
          value={zoneId}
          onChange={setZoneId}
          empty="No completed Zone to correct."
          options={zones.map((candidate) => ({
            value: candidate.id,
            label: zoneDisplayLabel(candidate.zoneCodeSnapshot, candidate.zoneNameSnapshot),
          }))}
        />

        {zone ? (
          <>
            <SectionHead
              title="Answers"
              description={
                changed.length > 0
                  ? `${changed.length} changed, marked with an amber edge.`
                  : 'Tap a different mark to change an answer.'
              }
            />
            {[...zone.responses]
              .sort((a, b) => a.globalOrder - b.globalOrder)
              .map((response) => {
                const question = byId.get(response.checklistQuestionId);
                const value = changes[response.id] ?? response.value;
                return (
                  <Card key={response.id} rail={value !== response.value ? 'warn' : undefined}>
                    <View style={styles.questionHead}>
                      <Text style={styles.questionNumber}>Q{response.globalOrder}</Text>
                      <Text style={styles.question}>
                        {question?.text ?? 'The wording is not on this phone yet. Sync the catalogue to see it.'}
                      </Text>
                    </View>
                    <ResponseChips
                      value={value}
                      allowsNa={question ? question.allowsNa === 1 : true}
                      onChange={(next) => setChanges((current) => ({ ...current, [response.id]: next }))}
                    />
                  </Card>
                );
              })}
            <Card>
              <Field
                label="Zone remark"
                multiline
                value={remark}
                onChangeText={setRemark}
                containerStyle={styles.lastField}
              />
            </Card>
          </>
        ) : null}

        <Field
          label="Reason for the change"
          hint="At least 10 characters. It is kept with the change in the activity log."
          multiline
          value={justification}
          onChangeText={setJustification}
        />
        <ErrorBanner message={problemMessage(save.error)} />
      </ScrollView>
      <ActionBar>
        <Button
          title="Save correction"
          busy={save.isPending}
          disabled={!dirty || justification.trim().length < 10}
          onPress={() => save.mutate()}
        />
      </ActionBar>
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { paddingBottom: theme.space.lg },
  questionHead: { flexDirection: 'row', gap: 10, marginBottom: theme.space.md },
  questionNumber: {
    fontFamily: theme.family.monoMedium,
    fontSize: 13,
    lineHeight: 22,
    color: theme.color.ink3,
    fontVariant: ['tabular-nums'],
  },
  question: { flex: 1, fontFamily: theme.family.medium, fontSize: theme.font.base, lineHeight: 22, color: theme.color.ink },
  lastField: { marginBottom: 0 },
}));
