import { useState } from 'react';
import { ScrollView } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { AuditAssignment, Page, Unit, User } from '@audit5s/contracts';
import {
  ActionBar,
  Button,
  ChoiceList,
  ErrorBanner,
  Field,
  Label,
  Screen,
  Segmented,
  Slip,
  SlipText,
} from '../../components/ui';
import { api, problemMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { createThemedStyles } from '../../lib/theme';

type Due = 'NONE' | 'TODAY' | 'WEEK' | 'FORTNIGHT';
const DUES = [
  { value: 'NONE', label: 'No date' },
  { value: 'TODAY', label: 'Today' },
  { value: 'WEEK', label: '7 days' },
  { value: 'FORTNIGHT', label: '14 days' },
] as const;
const TYPES = [
  { value: 'EXTERNAL_5S', label: '5S audit' },
  { value: 'WALK_BY', label: 'Walk-by' },
] as const;

/** End of the chosen day, local time. Presets rather than a date picker: no new dependency. */
function dueAt(due: Due): string | undefined {
  if (due === 'NONE') return undefined;
  const date = new Date();
  date.setDate(date.getDate() + (due === 'TODAY' ? 0 : due === 'WEEK' ? 7 : 14));
  date.setHours(23, 59, 0, 0);
  return date.toISOString();
}

/**
 * Assign an audit — `POST /audit-assignments`, the web's flow. Only a consultant who can
 * reach the Unit is offered (AA-1): the server refuses anyone else, so the list does too.
 */
export default function AssignScreen() {
  const styles = useStyles();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ unitId?: string; auditorUserId?: string }>();
  const [unitId, setUnitId] = useState<string | null>(params.unitId ?? null);
  const [auditorUserId, setAuditorUserId] = useState<string | null>(params.auditorUserId ?? null);
  const [auditType, setAuditType] = useState<'EXTERNAL_5S' | 'WALK_BY'>('EXTERNAL_5S');
  const [due, setDue] = useState<Due>('WEEK');
  const [instructions, setInstructions] = useState('');

  const units = useQuery({ queryKey: ['units'], queryFn: () => api.get<Page<Unit>>('/units?limit=200') });
  const consultants = useQuery({
    queryKey: ['users', 'CONSULTANT', 'unit', unitId],
    queryFn: () => api.get<Page<User>>(`/users?limit=200&role=CONSULTANT&status=ACTIVE&unitId=${unitId}`),
    enabled: unitId !== null,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<AuditAssignment>('/audit-assignments', {
        unitId,
        auditorUserId,
        auditType,
        ...(dueAt(due) ? { dueAt: dueAt(due) } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['audit-assignments'] });
      await queryClient.invalidateQueries({ queryKey: ['audits'] });
    },
  });

  if (create.data) {
    const assignment = create.data;
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Audit assigned' }} />
        <ScrollView contentContainerStyle={styles.content}>
          <Slip title="Audit assigned">
            <SlipText>
              {assignment.auditorName} sees the {assignment.unitName} audit after their phone next syncs
              {assignment.dueAt ? `. Due ${formatDate(assignment.dueAt)}.` : '.'}
            </SlipText>
          </Slip>
        </ScrollView>
        <ActionBar>
          <Button title="Done" onPress={() => router.back()} />
          <Button title="Assign another" variant="secondary" onPress={() => create.reset()} />
        </ActionBar>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Assign an audit' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Label>Unit</Label>
        <ChoiceList
          value={unitId}
          onChange={(next) => {
            setUnitId(next);
            setAuditorUserId(null);
          }}
          empty={units.isLoading ? 'Loading Units…' : 'Add a Unit first.'}
          options={(units.data?.data ?? []).map((unit) => ({ value: unit.id, label: unit.name }))}
        />
        {unitId ? (
          <>
            <Label>Consultant</Label>
            <ChoiceList
              value={auditorUserId}
              onChange={setAuditorUserId}
              empty={
                consultants.isLoading
                  ? 'Loading consultants…'
                  : 'No active consultant can reach this Unit. Give one access from People first.'
              }
              options={(consultants.data?.data ?? []).map((user) => ({
                value: user.id,
                label: user.fullName,
                detail: user.loginId,
              }))}
            />
          </>
        ) : null}
        <Label>Type</Label>
        <Segmented options={TYPES} value={auditType} onChange={setAuditType} />
        <Label>Due</Label>
        <Segmented options={DUES} value={due} onChange={setDue} />
        <Field
          label="Instructions (optional)"
          multiline
          value={instructions}
          onChangeText={setInstructions}
          placeholder="Anything the consultant should know before they go"
        />
        <ErrorBanner message={problemMessage(create.error)} />
      </ScrollView>
      <ActionBar>
        <Button
          title="Assign audit"
          busy={create.isPending}
          disabled={!unitId || !auditorUserId}
          onPress={() => create.mutate()}
        />
      </ActionBar>
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.lg },
}));
