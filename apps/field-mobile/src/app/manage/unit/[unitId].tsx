import { useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { MembershipDetail, Page, Unit, User, Zone } from '@audit5s/contracts';
import { zoneDisplayLabel } from '@audit5s/domain';
import { UnitForm } from '../../../components/unit-form';
import {
  Button,
  Card,
  CardHeader,
  ChoiceList,
  ConfirmAction,
  Data,
  EmptyState,
  ErrorBanner,
  HeaderAction,
  LedgerRow,
  Muted,
  Screen,
} from '../../../components/ui';
import { api, problemMessage } from '../../../lib/api';
import { ROLE_LABELS } from '../../../lib/labels';
import { createThemedStyles, useTheme } from '../../../lib/theme';

/**
 * One Unit, for a Super Admin: its details, its Zones, the people with access, and the way
 * to start an audit there. Archiving is the "delete": nothing in the audit trail is ever
 * removed (D8), so the Unit leaves every list and keeps its history.
 */
export default function ManageUnitScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { unitId } = useLocalSearchParams<{ unitId: string }>();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  const unit = useQuery({ queryKey: ['unit', unitId], queryFn: () => api.get<Unit>(`/units/${unitId}`) });
  const zones = useQuery({
    queryKey: ['zones', unitId],
    queryFn: () => api.get<Page<Zone>>(`/zones?limit=200&unitId=${unitId}`),
  });
  const members = useQuery({
    queryKey: ['memberships', 'unit', unitId],
    queryFn: () => api.get<Page<MembershipDetail>>(`/memberships?limit=200&unitId=${unitId}&status=ACTIVE`),
  });
  const people = useQuery({
    queryKey: ['users', 'all-active'],
    queryFn: () => api.get<Page<User>>('/users?limit=200&status=ACTIVE'),
    enabled: adding,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['memberships'] }),
      queryClient.invalidateQueries({ queryKey: ['users'] }),
    ]);
  const grant = useMutation({
    mutationFn: (userId: string) => api.post(`/units/${unitId}/memberships`, { userId }),
    onSuccess: async () => {
      setAdding(false);
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (membership: MembershipDetail) => api.delete(`/units/${unitId}/memberships/${membership.id}`),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: () => api.post(`/units/${unitId}/archive`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['units'] });
      router.back();
    },
  });

  if (unit.isLoading) {
    return (
      <Screen style={styles.centered}>
        <ActivityIndicator color={theme.color.ink} />
      </Screen>
    );
  }
  if (!unit.data) {
    return (
      <Screen>
        <EmptyState title="Unit not available" detail={problemMessage(unit.error) ?? 'It may have been archived.'} />
      </Screen>
    );
  }

  const u = unit.data;
  const memberIds = new Set((members.data?.data ?? []).map((member) => member.userId));
  const addable = (people.data?.data ?? []).filter(
    (person) => person.role !== 'SUPER_ADMIN' && !memberIds.has(person.id),
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: u.name }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {editing ? (
          <UnitForm unit={u} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
        ) : (
          <Card>
            <CardHeader
              title="Details"
              action={<HeaderAction title="Edit" accessibilityLabel="Edit the Unit's details" onPress={() => setEditing(true)} />}
            />
            <LedgerRow label="Address" value={u.address ?? '—'} />
            <LedgerRow label="City" value={[u.city, u.state, u.postalCode].filter(Boolean).join(', ') || '—'} />
            <LedgerRow label="Contact" value={u.contactName ?? '—'} />
            <LedgerRow label="Phone" value={u.contactPhone ?? '—'} />
            <LedgerRow label="Email" value={u.contactEmail ?? '—'} />
            <LedgerRow label="Geofence" value={u.geofenceRadiusM ? `${u.geofenceRadiusM} m` : 'Off'} last />
          </Card>
        )}

        <Card>
          <CardHeader
            title="Zones"
            description={zones.data ? `${zones.data.data.length} active. Zones are added and led from the web app.` : null}
          />
          {(zones.data?.data ?? []).map((zone, index, all) => (
            <View key={zone.id} style={[styles.item, index === all.length - 1 && styles.itemLast]}>
              <Text style={styles.itemTitle}>{zoneDisplayLabel(zone.code, zone.name)}</Text>
              <Data>{zone.zoneLeaderName ? `Leader ${zone.zoneLeaderName}` : 'No Zone Leader'}</Data>
            </View>
          ))}
          {zones.data && zones.data.data.length === 0 ? <Muted>No Zones yet.</Muted> : null}
        </Card>

        <Card>
          <CardHeader
            title="People"
            description="Who can reach this Unit. Revoking access removes it from their phone on its next sync."
          />
          {(members.data?.data ?? []).map((member) => (
            <View key={member.id} style={styles.item}>
              <View style={styles.memberHead}>
                <View style={styles.memberText}>
                  <Text style={styles.itemTitle}>{member.userFullName}</Text>
                  <Data>
                    {ROLE_LABELS[member.role]}, {member.userLoginId}
                  </Data>
                </View>
                <ConfirmAction
                  compact
                  title="Revoke"
                  question={`Revoke ${member.userFullName}'s access to ${u.name}? Their past audits stay.`}
                  confirmLabel="Revoke"
                  busy={revoke.isPending && revoke.variables?.id === member.id}
                  onConfirm={() => revoke.mutate(member)}
                />
              </View>
            </View>
          ))}
          {members.data && members.data.data.length === 0 ? <Muted>Nobody has access yet.</Muted> : null}
          <ErrorBanner message={problemMessage(revoke.error ?? grant.error)} />
          {adding ? (
            <View style={styles.adding}>
              <ChoiceList
                value={null}
                onChange={(userId) => grant.mutate(userId)}
                empty={people.isLoading ? 'Loading people…' : 'Everyone active already has access.'}
                options={addable.map((person) => ({
                  value: person.id,
                  label: person.fullName,
                  detail: `${ROLE_LABELS[person.role]}, ${person.loginId}`,
                }))}
              />
              <Button title="Cancel" variant="secondary" onPress={() => setAdding(false)} />
            </View>
          ) : (
            <Button title="Give someone access" variant="secondary" onPress={() => setAdding(true)} />
          )}
        </Card>

        <View style={styles.actions}>
          <Button
            title="Start an audit here"
            onPress={() => router.push({ pathname: '/unit/[unitId]', params: { unitId } })}
          />
          <ConfirmAction
            title="Archive Unit"
            question={`Archive ${u.name}? It leaves every list and no new audit can start there. Its audits, reports and people's history are kept.`}
            confirmLabel="Archive"
            busy={archive.isPending}
            onConfirm={() => archive.mutate()}
          />
          <ErrorBanner message={problemMessage(archive.error)} />
        </View>
      </ScrollView>
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  centered: { alignItems: 'center', justifyContent: 'center' },
  content: { paddingBottom: theme.space.xl },
  item: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.edgeSoft,
    gap: 2,
  },
  itemLast: { borderBottomWidth: 0, paddingBottom: 0 },
  itemTitle: { flexShrink: 1, fontFamily: theme.family.medium, fontSize: theme.font.base, color: theme.color.ink },
  memberHead: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: theme.space.sm },
  memberText: { flex: 1, minWidth: 160, gap: 2 },
  adding: { marginTop: theme.space.md, gap: theme.space.sm },
  actions: { gap: theme.space.sm, marginTop: theme.space.sm },
}));
