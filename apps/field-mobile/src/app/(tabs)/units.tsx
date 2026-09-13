import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Tabs, useRouter } from 'expo-router';
import type { Page, Unit } from '@audit5s/contracts';
import {
  Card,
  Data,
  EmptyState,
  ErrorBanner,
  HeaderAction,
  Muted,
  Screen,
  SearchField,
  SectionHead,
} from '../../components/ui';
import { api } from '../../lib/api';
import { createThemedStyles, useTheme } from '../../lib/theme';

/** Every Unit the organization runs, for a Super Admin: search, add, open. Live server data. */
export default function ManageUnitsScreen() {
  const styles = useStyles();
  const theme = useTheme();
  const router = useRouter();
  const [search, setSearch] = useState('');

  const units = useQuery({ queryKey: ['units'], queryFn: () => api.get<Page<Unit>>('/units?limit=200') });

  // ponytail: the first 200 Units, filtered on the device as the web does; search on the
  // server (`?search=`) once an organization has more.
  const query = search.trim().toLocaleLowerCase();
  const list = (units.data?.data ?? []).filter((unit) =>
    [unit.name, unit.city, unit.state].some((value) => value?.toLocaleLowerCase().includes(query)),
  );

  const renderItem = useCallback(
    ({ item }: { item: Unit }) => (
      <Card
        accessibilityRole="button"
        onPress={() => router.push({ pathname: '/manage/unit/[unitId]', params: { unitId: item.id } })}
      >
        <Text style={styles.name}>{item.name}</Text>
        <Muted>{[item.city, item.state].filter(Boolean).join(', ') || 'No address yet'}</Muted>
        {item.contactName ? (
          <Data>
            {item.contactName}
            {item.contactPhone ? `, ${item.contactPhone}` : ''}
          </Data>
        ) : null}
      </Card>
    ),
    [styles, router],
  );

  return (
    <Screen>
      <Tabs.Screen
        options={{
          headerRight: () => (
            <View style={styles.tools}>
              <HeaderAction testID="add-unit" title="+ Unit" accessibilityLabel="Add a Unit" onPress={() => router.push('/manage/new-unit')} />
            </View>
          ),
        }}
      />
      <FlatList
        data={list}
        keyExtractor={(unit) => unit.id}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={units.isRefetching} onRefresh={() => void units.refetch()} />}
        ListHeaderComponent={
          <>
            <SearchField value={search} onChangeText={setSearch} placeholder="Search Units by name or city" />
            <ErrorBanner
              message={units.error ? 'Units could not load. This needs a connection; pull down to try again.' : null}
            />
            {units.data ? (
              <SectionHead
                title={`${list.length} Unit${list.length === 1 ? '' : 's'}`}
                description={query ? `Matching “${search.trim()}”` : 'Open a Unit for its details, Zones and people.'}
              />
            ) : null}
          </>
        }
        ListEmptyComponent={
          units.isLoading ? (
            <ActivityIndicator color={theme.color.ink} />
          ) : units.data ? (
            <EmptyState
              title={query ? 'No match' : 'No Units yet'}
              detail={query ? 'Try another name or city.' : 'Add the first Unit with + Unit.'}
            />
          ) : null
        }
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  tools: { marginRight: theme.space.md },
  name: {
    fontFamily: theme.family.bold,
    fontSize: theme.font.panel,
    color: theme.color.ink,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
}));
