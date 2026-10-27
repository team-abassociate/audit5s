import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { Audit, MembershipDetail, Page, ResetUserPasswordResponse, Unit, User, Zone } from '@audit5s/contracts';
import { mayGrantKaizen, zoneDisplayLabel } from '@audit5s/domain';
import {
  Avatar,
  Button,
  Card,
  CardHeader,
  CheckRow,
  Chip,
  ChoiceList,
  ConfirmAction,
  Data,
  EmptyState,
  ErrorBanner,
  Field,
  HeaderAction,
  LedgerRow,
  Muted,
  Screen,
  Slip,
  SlipText,
} from '../../../components/ui';
import { api, problemMessage } from '../../../lib/api';
import { formatDate, formatDateTime } from '../../../lib/format';
import {
  AUDIT_STATUS_LABELS,
  AUDIT_STATUS_TONE,
  AUDIT_TYPE_LABELS,
  ROLE_LABELS,
  USER_STATUS,
} from '../../../lib/labels';
import { useRequiredFields } from '../../../lib/required-fields';
import { useSession } from '../../../lib/session';
import { createThemedStyles, useTheme } from '../../../lib/theme';

/**
 * One person: who they are, the Units they can reach (revoke or grant from here), the audits
 * they have run, and their account. Disabling is the "delete": they can no longer sign in,
 * and nothing they recorded goes anywhere (D8).
 *
 * A Coordinator (R-24) manages the Zone Leaders of their own Unit — edit, reset, disable — and
 * reads everyone else. Unit access is the Super Admin's to give and take (§6.3).
 */
export default function PersonScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { scope, can, user: self } = useSession();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const [editing, setEditing] = useState(false);
  const [granting, setGranting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const person = useQuery({ queryKey: ['user', userId], queryFn: () => api.get<User>(`/users/${userId}`) });
  const memberships = useQuery({
    queryKey: ['memberships', 'user', userId],
    queryFn: () => api.get<Page<MembershipDetail>>(`/memberships?limit=200&userId=${userId}&status=ACTIVE`),
  });
  const audits = useQuery({
    queryKey: ['audits', 'auditor', userId],
    queryFn: () => api.get<Page<Audit>>(`/audits?limit=50&auditorId=${userId}`),
    enabled: person.data?.role === 'CONSULTANT' || person.data?.role === 'ZONE_LEADER',
  });
  // A Zone Leader holds one active membership: the Unit whose Zones they may lead.
  const leaderUnitId = person.data?.role === 'ZONE_LEADER' ? memberships.data?.data[0]?.unitId : undefined;
  const zones = useQuery({
    queryKey: ['zones', leaderUnitId],
    queryFn: () => api.get<Page<Zone>>(`/units/${leaderUnitId}/zones?limit=200`),
    enabled: Boolean(leaderUnitId),
  });
  const units = useQuery({
    queryKey: ['units'],
    queryFn: () => api.get<Page<Unit>>('/units?limit=200'),
    enabled: granting,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['user', userId] }),
      queryClient.invalidateQueries({ queryKey: ['users'] }),
      queryClient.invalidateQueries({ queryKey: ['memberships'] }),
    ]);
  const revoke = useMutation({
    mutationFn: (membership: MembershipDetail) =>
      api.delete(`/units/${membership.unitId}/memberships/${membership.id}`),
    onSuccess: refresh,
  });
  const grant = useMutation({
    mutationFn: (unitId: string) => api.post(`/units/${unitId}/memberships`, { userId }),
    onSuccess: async () => {
      setGranting(false);
      await refresh();
    },
  });
  // The Zone's own leader pointer; ticking a Zone someone else leads hands it over.
  const lead = useMutation({
    mutationFn: ({ zoneId, leads }: { zoneId: string; leads: boolean }) =>
      api.post<Zone>(`/zones/${zoneId}/leader`, { zoneLeaderId: leads ? userId : null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['zones'] }),
  });
  /** R-57: Kaizen, given and taken back like Unit access. */
  const kaizenAccess = useMutation({
    mutationFn: (granted: boolean) => api.patch<User>(`/users/${userId}`, { kaizenAccess: granted }),
    onSuccess: refresh,
  });
  const disable = useMutation({
    mutationFn: () => api.post(`/users/${userId}/disable`, {}),
    onSuccess: refresh,
  });
  // Undoes Disable, under the same permission, as the web's Restore access does.
  const enable = useMutation({
    mutationFn: () => api.post(`/users/${userId}/enable`),
    onSuccess: refresh,
  });
  const reset = useMutation({
    mutationFn: () => api.post<ResetUserPasswordResponse>(`/users/${userId}/reset-password`),
    onSuccess: async (result) => {
      setNotice(
        `${result.loginId} signs in with their phone number until ${formatDateTime(result.bootstrapExpiresAt)}, then chooses a new password.`,
      );
      await refresh();
    },
  });

  /**
   * Removal, as far as D8 allows (R-25): archived and disabled, never deleted. Their audits,
   * photographs and activity log stay exactly as they are; the account leaves every list.
   */
  const remove = useMutation({
    mutationFn: () => api.post(`/users/${userId}/archive`, {}),
    onSuccess: async () => {
      await refresh();
      router.back();
    },
  });

  if (person.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.ink} />
      </Screen>
    );
  }
  if (!person.data) {
    return (
      <Screen>
        <EmptyState title="Person not available" detail={problemMessage(person.error) ?? undefined} />
      </Screen>
    );
  }

  const p = person.data;
  // A Super Admin manages anyone; a Coordinator only Zone Leaders (§6.3's "role = ZONE_LEADER").
  const manages = scope?.role === 'SUPER_ADMIN' || (can('user', 'update') && p.role === 'ZONE_LEADER');
  const mayGrant = can('unit_membership', 'create');
  const mayRevoke = can('unit_membership', 'revoke');
  const live = (audits.data?.data ?? []).find((audit) =>
    ['ASSIGNED', 'READY', 'IN_PROGRESS', 'PAUSED'].includes(audit.status),
  );
  const memberUnitIds = new Set((memberships.data?.data ?? []).map((membership) => membership.unitId));
  const grantable = (units.data?.data ?? []).filter((unit) => !memberUnitIds.has(unit.id));

  return (
    <Screen>
      <Stack.Screen options={{ title: p.fullName }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {notice ? (
          <Slip title="Password reset">
            <SlipText>{notice}</SlipText>
          </Slip>
        ) : null}

        <Card>
          <View style={styles.who}>
            <Avatar name={p.fullName} />
            <View style={styles.whoText}>
              <Text style={styles.name}>{p.fullName}</Text>
              <Data>{p.loginId ?? 'No login yet: add their mobile number'}</Data>
              <View style={styles.chips}>
                <Chip>{ROLE_LABELS[p.role]}</Chip>
                <Chip tone={USER_STATUS[p.status].tone}>{USER_STATUS[p.status].label}</Chip>
                {live ? <Chip tone="warn">On audit</Chip> : null}
              </View>
            </View>
          </View>
        </Card>

        {editing ? (
          <EditPerson user={p} onDone={() => setEditing(false)} />
        ) : (
          <Card>
            <CardHeader
              title="Details"
              action={
                manages ? <HeaderAction icon="edit" title="Edit" accessibilityLabel="Edit details" onPress={() => setEditing(true)} /> : null
              }
            />
            <LedgerRow label="Phone" value={p.phoneE164 ?? 'Not added yet'} />
            <LedgerRow label="Email" value={p.email ?? '—'} />
            <LedgerRow label="Last sign-in" value={p.lastLoginAt ? formatDateTime(p.lastLoginAt) : 'Never'} />
            <LedgerRow label="Added" value={formatDate(p.createdAt)} last />
          </Card>
        )}

        <Card>
          <CardHeader
            title="Units"
            description={
              p.role === 'SUPER_ADMIN'
                ? 'A Super Admin reaches every Unit.'
                : mayRevoke
                  ? 'Revoking access removes the Unit from their phone on its next sync. Their past audits stay.'
                  : 'Unit access is given and removed by a Super Admin.'
            }
          />
          {(memberships.data?.data ?? []).map((membership) => (
            <View key={membership.id} style={styles.item}>
              <View style={styles.auditHead}>
                <View style={styles.itemText}>
                  <Text style={styles.itemTitle}>{membership.unitName}</Text>
                  <Data>Since {formatDate(membership.validFrom)}</Data>
                </View>
                {mayRevoke ? (
                  <ConfirmAction
                    compact
                    title="Revoke"
                    question={`Revoke ${p.fullName}'s access to ${membership.unitName}?`}
                    confirmLabel="Revoke"
                    busy={revoke.isPending && revoke.variables?.id === membership.id}
                    onConfirm={() => revoke.mutate(membership)}
                  />
                ) : null}
              </View>
            </View>
          ))}
          {memberships.data && memberships.data.data.length === 0 && p.role !== 'SUPER_ADMIN' ? (
            <Muted>No Unit yet, so they can reach nothing.</Muted>
          ) : null}
          <ErrorBanner message={problemMessage(revoke.error ?? grant.error)} />
          {p.role === 'SUPER_ADMIN' || !mayGrant ? null : granting ? (
            <View style={styles.granting}>
              <ChoiceList
                value={null}
                onChange={(unitId) => grant.mutate(unitId)}
                empty={units.isLoading ? 'Loading Units…' : 'They already reach every Unit.'}
                options={grantable.map((unit) => ({ value: unit.id, label: unit.name }))}
              />
              <Button icon="close" title="Cancel" variant="secondary" onPress={() => setGranting(false)} />
            </View>
          ) : (
            <Button icon="vpn-key" title="Give access to a Unit" variant="secondary" onPress={() => setGranting(true)} />
          )}
        </Card>

        {leaderUnitId ? (
          <Card>
            <CardHeader
              title="Zones they lead"
              description={
                can('zone', 'assign_leader')
                  ? 'Tick the Zones they lead. A Zone has one leader, so ticking one led by someone else moves it to them.'
                  : 'Zone leaders are set by the Coordinator.'
              }
            />
            {(zones.data?.data ?? []).map((zone) => {
              const leads = zone.zoneLeaderId === p.id;
              return (
                <CheckRow
                  key={zone.id}
                  label={zoneDisplayLabel(zone.code, zone.name)}
                  detail={!leads && zone.zoneLeaderName ? `Now ${zone.zoneLeaderName}` : null}
                  checked={leads}
                  onChange={(next) => {
                    if (can('zone', 'assign_leader') && !lead.isPending) lead.mutate({ zoneId: zone.id, leads: next });
                  }}
                />
              );
            })}
            {zones.data && zones.data.data.length === 0 ? <Muted>This Unit has no Zones yet.</Muted> : null}
            <ErrorBanner message={problemMessage(zones.error ?? lead.error)} />
          </Card>
        ) : null}

        {p.role === 'SUPER_ADMIN' ? null : (
          <Card>
            <CardHeader
              title="Kaizen"
              description={p.kaizenAccess ? 'They can open Kaizen.' : 'They cannot open Kaizen until someone gives them access.'}
            />
            {self && mayGrantKaizen({ ...self, userId: self.id }, p) ? (
              p.kaizenAccess ? (
                <ConfirmAction
                  title="Remove Kaizen access"
                  question={`Remove ${p.fullName}'s Kaizen access? They keep 5S. Their Kaizens stay on record.`}
                  confirmLabel="Remove"
                  busy={kaizenAccess.isPending}
                  onConfirm={() => kaizenAccess.mutate(false)}
                />
              ) : (
                <Button icon="vpn-key" title="Give Kaizen access" variant="secondary" busy={kaizenAccess.isPending} onPress={() => kaizenAccess.mutate(true)} />
              )
            ) : null}
            <ErrorBanner message={problemMessage(kaizenAccess.error)} />
          </Card>
        )}

        {audits.data ? (
          <Card>
            <CardHeader
              title="Audits"
              description={audits.data.data.length === 0 ? 'No audits yet.' : `${audits.data.data.length} most recent`}
            />
            {audits.data.data.map((audit) => (
              <Pressable
                key={audit.id}
                accessibilityRole="button"
                onPress={() => router.push({ pathname: '/manage/audit/[auditId]', params: { auditId: audit.id } })}
                style={({ pressed }) => [styles.item, pressed && styles.pressed]}
              >
                <View style={styles.auditHead}>
                  <Text style={styles.itemTitle}>{audit.unitName}</Text>
                  <Chip tone={AUDIT_STATUS_TONE[audit.status]}>{AUDIT_STATUS_LABELS[audit.status]}</Chip>
                </View>
                <Data>
                  {AUDIT_TYPE_LABELS[audit.auditType]}, {formatDate(audit.completedAt ?? audit.startedAt ?? audit.createdAt)}
                </Data>
              </Pressable>
            ))}
          </Card>
        ) : null}

        {manages ? (
          <Card>
            <CardHeader title="Account" />
            <View style={styles.accountActions}>
              <ConfirmAction
                title="Reset password"
                question={`Reset ${p.fullName}'s password? They are signed out and sign in again with their phone number.`}
                confirmLabel="Reset"
                busy={reset.isPending}
                onConfirm={() => reset.mutate()}
              />
              {p.status === 'DISABLED' ? (
                <ConfirmAction
                  title="Restore access"
                  question={`Restore ${p.fullName}'s access? They can sign in again with their own password.`}
                  confirmLabel="Restore"
                  busy={enable.isPending}
                  onConfirm={() => enable.mutate()}
                />
              ) : (
                <ConfirmAction
                  title="Disable account"
                  question={`Disable ${p.fullName}? They are signed out everywhere and cannot sign in. Nothing they recorded is deleted.`}
                  confirmLabel="Disable"
                  busy={disable.isPending}
                  onConfirm={() => disable.mutate()}
                />
              )}
              {can('user', 'archive') && scope?.role === 'SUPER_ADMIN' ? (
                <ConfirmAction
                  title="Remove from the system"
                  question={`Remove ${p.fullName}? They leave every list and can no longer sign in. Their audits, photographs and activity log are kept — a 5S record that could be erased would not be a record.`}
                  confirmLabel="Remove"
                  busy={remove.isPending}
                  onConfirm={() => remove.mutate()}
                />
              ) : null}
              <ErrorBanner message={problemMessage(disable.error ?? enable.error ?? reset.error ?? remove.error)} />
            </View>
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function EditPerson({ user, onDone }: { user: User; onDone: () => void }) {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState(user.fullName);
  const [phone, setPhone] = useState(user.phoneE164 ?? '');
  const [email, setEmail] = useState(user.email ?? '');
  // No scroll ref here: focusing the box is enough, Android scrolls a focused input into view.
  const required = useRequiredFields<'name'>();

  const save = useMutation({
    mutationFn: () =>
      api.patch<User>(`/users/${user.id}`, {
        fullName: fullName.trim(),
        // R-65: an account waiting for its number keeps waiting until one is typed.
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        email: email.trim() || null,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['user', user.id] });
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      onDone();
    },
  });

  return (
    <Card>
      <CardHeader title="Edit details" />
      <Field
        label="Full name"
        inputRef={required.input('name')}
        error={required.error('name', 'Enter their full name.', fullName.trim() !== '')}
        value={fullName}
        onChangeText={setFullName}
        autoCapitalize="words"
      />
      <Field
        label="Mobile number"
        hint={user.loginId ? undefined : 'Adding it makes their login ID, and the number is their first password.'}
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
      />
      <Field label="Email (optional)" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
      <ErrorBanner message={problemMessage(save.error)} />
      <View style={styles.accountActions}>
        <Button icon="save" title="Save changes" busy={save.isPending} onPress={() => required.check([['name', fullName.trim() !== '']]) && save.mutate()} />
        <Button icon="close" title="Cancel" variant="secondary" onPress={onDone} />
      </View>
    </Card>
  );
}

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { paddingBottom: theme.space.xl },
  who: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  whoText: { flex: 1, gap: 2 },
  name: { fontFamily: theme.family.bold, fontSize: theme.font.panel, color: theme.color.ink, textTransform: 'uppercase' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  item: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.color.edgeSoft, gap: 2 },
  itemTitle: { flexShrink: 1, fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
  itemText: { flex: 1, minWidth: 160, gap: 2 },
  auditHead: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: theme.space.sm },
  pressed: { backgroundColor: theme.color.tile2 },
  granting: { marginTop: theme.space.md, gap: theme.space.sm },
  accountActions: { gap: theme.space.sm },
}));
