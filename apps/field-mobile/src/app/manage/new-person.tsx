import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { CreateUserResponse, Page, Unit } from '@audit5s/contracts';
import {
  ActionBar,
  Button,
  Card,
  CardHeader,
  ChoiceList,
  ErrorBanner,
  Field,
  Label,
  LedgerRow,
  Screen,
  Segmented,
  Slip,
  SlipText,
} from '../../components/ui';
import { api, problemMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { ROLE_LABELS } from '../../lib/labels';
import { createThemedStyles } from '../../lib/theme';

type PeopleRole = 'CONSULTANT' | 'COORDINATOR' | 'ZONE_LEADER';
const ROLES = [
  { value: 'CONSULTANT', label: 'Consultant' },
  { value: 'COORDINATOR', label: 'Coordinator' },
  { value: 'ZONE_LEADER', label: 'Zone leader' },
] as const;

/**
 * A new account. Every role except Super Admin needs a Unit, or it would reach nothing.
 * The first password is the phone number, never shown or sent back (§12.1): the screen
 * says so, with the login ID and the 72-hour window, so it can be passed on in person.
 */
export default function NewPersonScreen() {
  const styles = useStyles();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ role?: string; unitId?: string }>();
  const [role, setRole] = useState<PeopleRole>(
    ROLES.some((option) => option.value === params.role) ? (params.role as PeopleRole) : 'CONSULTANT',
  );
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [unitId, setUnitId] = useState<string | null>(params.unitId ?? null);

  const units = useQuery({ queryKey: ['units'], queryFn: () => api.get<Page<Unit>>('/units?limit=200') });

  const create = useMutation({
    mutationFn: () =>
      api.post<CreateUserResponse>('/users', {
        fullName: fullName.trim(),
        phone: phone.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        role,
        ...(unitId ? { unitId } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  const ready = fullName.trim() !== '' && /^\d{10}$/.test(phone.trim()) && unitId !== null;

  if (create.data) {
    const created = create.data;
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Account created' }} />
        <ScrollView contentContainerStyle={styles.content}>
          <Slip title={`${ROLE_LABELS[created.user.role]} created`}>
            <SlipText>
              Give {created.user.fullName} their login ID. Their first password is their phone number,
              valid until {formatDateTime(created.bootstrapExpiresAt)}, and they choose a new one when they sign in.
            </SlipText>
          </Slip>
          <Card>
            <CardHeader title={created.user.fullName} />
            <LedgerRow label="Login ID" value={created.loginId} />
            <LedgerRow label="Phone" value={created.user.phoneE164} last />
          </Card>
        </ScrollView>
        <ActionBar>
          <Button
            title="Open their profile"
            onPress={() => router.replace({ pathname: '/manage/person/[userId]', params: { userId: created.user.id } })}
          />
          <Button
            title="Add another"
            variant="secondary"
            onPress={() => {
              create.reset();
              setFullName('');
              setPhone('');
              setEmail('');
            }}
          />
        </ActionBar>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: `New ${ROLE_LABELS[role].toLowerCase()}` }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Label>Role</Label>
        <Segmented options={ROLES} value={role} onChange={setRole} />
        <Field label="Full name" value={fullName} onChangeText={setFullName} autoCapitalize="words" />
        <Field
          label="Mobile number"
          hint="10 digits. It is also their first password."
          value={phone}
          onChangeText={setPhone}
          keyboardType="number-pad"
          maxLength={10}
        />
        <Field
          label="Email (optional)"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <Label>Unit</Label>
        <ChoiceList
          value={unitId}
          onChange={setUnitId}
          empty={units.isLoading ? 'Loading Units…' : 'Add a Unit first.'}
          options={(units.data?.data ?? []).map((unit) => ({
            value: unit.id,
            label: unit.name,
            detail: [unit.city, unit.state].filter(Boolean).join(', ') || null,
          }))}
        />
        <View>
          <ErrorBanner message={problemMessage(create.error)} />
        </View>
      </ScrollView>
      <ActionBar>
        <Button
          title={`Create ${ROLE_LABELS[role].toLowerCase()}`}
          busy={create.isPending}
          disabled={!ready}
          onPress={() => create.mutate()}
        />
      </ActionBar>
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.lg },
}));
