import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Tabs, useRouter } from 'expo-router';
import type { Audit, Page, User } from '@audit5s/contracts';
import {
  Avatar,
  Card,
  Chip,
  Data,
  EmptyState,
  ErrorBanner,
  HeaderAction,
  Screen,
  SearchField,
  SectionHead,
  Segmented,
} from '../../components/ui';
import { api } from '../../lib/api';
import { ROLE_LABELS, USER_STATUS } from '../../lib/labels';
import { useSession } from '../../lib/session';
import { createThemedStyles, useTheme } from '../../lib/theme';

type PeopleRole = 'CONSULTANT' | 'COORDINATOR' | 'ZONE_LEADER';

const SEGMENTS = [
  { value: 'CONSULTANT', label: 'Consultants' },
  { value: 'COORDINATOR', label: 'Coordinators' },
  { value: 'ZONE_LEADER', label: 'Zone leaders' },
] as const;

const ABOUT: Record<PeopleRole, string> = {
  CONSULTANT: 'Consultants run external audits on their phones.',
  COORDINATOR: 'A coordinator manages a Unit and its Zone leaders.',
  ZONE_LEADER: 'Zone leaders keep their Zone in order and answer its corrective actions.',
};

/**
 * Everyone the organization has given an account, one role at a time, with one search.
 * Consultants on an audit right now come first, because that is who a Super Admin looks for.
 * A Coordinator (R-24) sees the people of their own Unit and adds Zone leaders only.
 */
export default function PeopleScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const { scope, can } = useSession();
  const isSuperAdmin = scope?.role === 'SUPER_ADMIN';
  const [role, setRole] = useState<PeopleRole>(isSuperAdmin ? 'CONSULTANT' : 'ZONE_LEADER');
  const [search, setSearch] = useState('');
  // A Coordinator creates Zone Leaders and nobody else (§6.3); the server holds the same line.
  const mayAdd = can('user', 'create') && (isSuperAdmin || role === 'ZONE_LEADER');

  const users = useQuery({
    queryKey: ['users', role],
    queryFn: () => api.get<Page<User>>(`/users?limit=200&role=${role}`),
  });
  const active = useQuery({
    queryKey: ['audits', 'active'],
    queryFn: () => api.get<Page<Audit>>('/audits?limit=200&active=true'),
    enabled: role === 'CONSULTANT',
    refetchInterval: 30_000,
  });

  const auditing = new Map((active.data?.data ?? []).map((audit) => [audit.auditorUserId, audit]));
  // ponytail: the first 200 of a role, filtered on the device as the web does.
  const query = search.trim().toLocaleLowerCase();
  const list = (users.data?.data ?? [])
    .filter((user) =>
      [user.fullName, user.loginId, user.email, user.phoneE164].some((value) =>
        value?.toLocaleLowerCase().includes(query),
      ),
    )
    .sort(
      (a, b) =>
        Number(auditing.has(b.id)) - Number(auditing.has(a.id)) || a.fullName.localeCompare(b.fullName),
    );
  const onAudit = list.filter((user) => auditing.has(user.id)).length;
  const label = SEGMENTS.find((segment) => segment.value === role)!.label;

  const renderItem = useCallback(
    ({ item }: { item: User }) => {
      const audit = auditing.get(item.id);
      return (
        <Card
          accessibilityRole="button"
          onPress={() => router.push({ pathname: '/manage/person/[userId]', params: { userId: item.id } })}
        >
          <View style={styles.row}>
            <Avatar name={item.fullName} size={40} />
            <View style={styles.text}>
              <Text style={styles.name}>{item.fullName}</Text>
              <Data>{item.loginId}</Data>
              {audit ? <Data>Auditing {audit.unitName}</Data> : null}
            </View>
            <View style={styles.chips}>
              {audit ? <Chip tone="warn">On audit</Chip> : null}
              {item.status !== 'ACTIVE' ? <Chip tone={USER_STATUS[item.status].tone}>{USER_STATUS[item.status].label}</Chip> : null}
            </View>
          </View>
        </Card>
      );
    },
    [styles, router, auditing],
  );

  return (
    <Screen>
      <Tabs.Screen
        options={{
          headerRight: () =>
            mayAdd ? (
              <View style={styles.tools}>
                <HeaderAction
                  testID="add-person"
                  title="+ Add"
                  accessibilityLabel={`Add a ${ROLE_LABELS[role].toLowerCase()}`}
                  onPress={() => router.push({ pathname: '/manage/new-person', params: { role } })}
                />
              </View>
            ) : null,
        }}
      />
      <FlatList
        data={list}
        keyExtractor={(user) => user.id}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={users.isRefetching} onRefresh={() => void users.refetch()} />}
        ListHeaderComponent={
          <>
            <Segmented options={SEGMENTS} value={role} onChange={setRole} />
            <SearchField value={search} onChangeText={setSearch} placeholder="Search by name, login ID or phone" />
            <ErrorBanner message={users.error ? 'People could not load. This needs a connection; pull down to try again.' : null} />
            {users.data ? (
              <SectionHead
                title={`${list.length} ${(list.length === 1 ? ROLE_LABELS[role] : label).toLowerCase()}`}
                description={role === 'CONSULTANT' ? `${onAudit} on an audit right now. ${ABOUT[role]}` : ABOUT[role]}
              />
            ) : null}
          </>
        }
        ListEmptyComponent={
          users.isLoading ? (
            <ActivityIndicator color={theme.color.ink} />
          ) : users.data ? (
            <EmptyState
              title={query ? 'No match' : `No ${label.toLowerCase()} yet`}
              detail={query ? 'Try another name, login ID or phone number.' : mayAdd ? 'Add one with + Add.' : undefined}
            />
          ) : null
        }
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  tools: { marginRight: theme.space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, gap: 1 },
  chips: { alignItems: 'flex-end', gap: 4 },
  name: { fontFamily: theme.family.bold, fontSize: theme.font.base, color: theme.color.ink, textTransform: 'uppercase' },
}));
