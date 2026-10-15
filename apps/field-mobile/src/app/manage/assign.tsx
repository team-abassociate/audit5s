import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
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
  SelectField,
  Slip,
  SlipText,
} from '../../components/ui';
import { api, problemMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { createThemedStyles } from '../../lib/theme';
import { useRequiredFields } from '../../lib/required-fields';

const TYPES = [
  { value: 'EXTERNAL_5S', label: '5S audit' },
  { value: 'WALK_BY', label: 'Walk-by' },
] as const;

/** End of the chosen day, local time. */
function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setHours(23, 59, 0, 0);
  return end;
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
  const [due, setDue] = useState<Date | null>(() => endOfDay(new Date(Date.now() + 7 * 86_400_000)));
  const [instructions, setInstructions] = useState('');
  const required = useRequiredFields<'unit' | 'consultant'>();

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
        ...(due ? { dueAt: due.toISOString() } : {}),
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
          <Button icon="check" title="Done" onPress={() => router.back()} />
          <Button icon="add" title="Assign another" variant="secondary" onPress={() => create.reset()} />
        </ActionBar>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Assign an audit' }} />
      <ScrollView ref={required.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View ref={required.anchor('unit')} collapsable={false}>
        <SelectField
          label="Unit"
          placeholder={units.isLoading ? 'Loading Units…' : 'Choose the Unit'}
          value={unitId}
          onChange={(next) => {
            setUnitId(next);
            setAuditorUserId(null);
          }}
          options={(units.data?.data ?? []).map((unit) => ({ value: unit.id, label: unit.name }))}
        />
        {required.flagged('unit', unitId !== null) ? <ErrorBanner message="Choose a Unit." /> : null}
        </View>
        {unitId ? (
          <View ref={required.anchor('consultant')} collapsable={false}>
            <Label>Consultant</Label>
            {required.flagged('consultant', auditorUserId !== null) ? (
              <ErrorBanner message="Choose the consultant who will do the audit." />
            ) : null}
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
          </View>
        ) : null}
        <Label>Type</Label>
        <Segmented options={TYPES} value={auditType} onChange={setAuditType} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={due ? `Due: ${formatDate(due.toISOString())}` : 'Due: no date'}
          onPress={() =>
            DateTimePickerAndroid.open({
              value: due ?? new Date(),
              mode: 'date',
              minimumDate: new Date(),
              onChange: (event, date) => {
                if (event.type === 'set' && date) setDue(endOfDay(date));
              },
            })
          }
        >
          {/* The text box's own look, so it reads as one more box on the form. */}
          <View pointerEvents="none">
            <Field label="Due" value={due ? formatDate(due.toISOString()) : ''} placeholder="No date" editable={false} />
          </View>
        </Pressable>
        {due ? <Button icon="event-busy" title="No due date" variant="secondary" onPress={() => setDue(null)} /> : null}
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
        <Button icon="assignment-ind"
          title="Assign audit"
          busy={create.isPending}
          onPress={() =>
            required.check([
              ['unit', unitId !== null],
              ['consultant', auditorUserId !== null],
            ]) && create.mutate()
          }
        />
      </ActionBar>
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.lg },
}));
