import { FlatList, Pressable, StyleSheet, Text } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import type { NotificationPage } from '@audit5s/contracts';
import { EmptyState, ErrorBanner, Muted, Screen } from '../components/ui';
import { api } from '../lib/api';
import { theme } from '../lib/theme';

/**
 * The notification centre (§8.10). Notifications are server rows written by a worker, so
 * this is the one field screen that needs the network; offline it says so and keeps the
 * last page it had.
 */
export default function NotificationsScreen() {
  const queryClient = useQueryClient();
  const page = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationPage>('/notifications?limit=50'),
  });
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Notifications' }} />
      <ErrorBanner message={page.error ? 'Could not reach the server — connect to see new notifications.' : null} />
      <FlatList
        data={page.data?.data ?? []}
        keyExtractor={(notification) => notification.id}
        refreshing={page.isFetching}
        onRefresh={() => void page.refetch()}
        ListEmptyComponent={page.isLoading ? null : <EmptyState title="Nothing here" />}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, !item.readAt && styles.unread]}
            onPress={() => !item.readAt && markRead.mutate(item.id)}
          >
            <Text style={[styles.title, !item.readAt && styles.bold]}>{item.title}</Text>
            <Text style={styles.body}>{item.body}</Text>
            <Muted>{new Date(item.createdAt).toLocaleString()}</Muted>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: theme.space.sm,
    paddingHorizontal: theme.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.textMuted,
  },
  unread: { backgroundColor: '#FFF7F3' },
  title: { fontSize: theme.font.base, color: theme.color.text },
  bold: { fontWeight: '700' },
  body: { fontSize: theme.font.sm, color: theme.color.text, marginVertical: theme.space.xs },
});
