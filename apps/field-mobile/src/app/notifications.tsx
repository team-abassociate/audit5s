import { useCallback } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import type { NotificationPage } from '@audit5s/contracts';
import { Card, Chip, Data, EmptyState, ErrorBanner, Screen } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { createThemedStyles } from '../lib/theme';

type Notification = NotificationPage['data'][number];

/**
 * The notification centre (§8.10). Notifications are server rows written by a worker, so
 * this is the one field screen that needs the network; offline it says so and keeps the
 * last page it had.
 *
 * Unread is an ink rail plus a "New" chip — shape and word, never the accent as a fill.
 */
export default function NotificationsScreen() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const page = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationPage>('/notifications?limit=50'),
  });
  const { mutate: markRead } = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const renderItem = useCallback(
    ({ item }: { item: Notification }) => {
      const unread = !item.readAt;
      return (
        <Card
          style={unread ? styles.unread : undefined}
          onPress={unread ? () => markRead(item.id) : undefined}
          accessibilityRole={unread ? 'button' : undefined}
          accessibilityHint={unread ? 'Marks this notification as read' : undefined}
        >
          <View style={styles.head}>
            <Text style={[styles.title, unread && styles.bold]}>{item.title}</Text>
            {unread ? <Chip>New</Chip> : null}
          </View>
          <Text style={styles.body}>{item.body}</Text>
          <Data>{formatDateTime(item.createdAt)}</Data>
        </Card>
      );
    },
    [styles, markRead],
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Notifications' }} />
      <ErrorBanner message={page.error ? 'Could not reach the server. Connect to see new notifications.' : null} />
      <FlatList
        data={page.data?.data ?? []}
        keyExtractor={(notification) => notification.id}
        refreshing={page.isFetching}
        onRefresh={() => void page.refetch()}
        renderItem={renderItem}
        ListEmptyComponent={
          page.isLoading ? null : (
            <EmptyState
              title="Nothing here"
              detail="Updates about your audits and corrective actions appear here. Pull down to check again."
            />
          )
        }
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  unread: { borderLeftWidth: 4, borderLeftColor: theme.color.ink },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: theme.space.sm },
  title: { flex: 1, fontFamily: theme.family.regular, fontSize: theme.font.base, color: theme.color.ink },
  bold: { fontFamily: theme.family.bold },
  body: {
    fontFamily: theme.family.regular,
    fontSize: theme.font.sm,
    lineHeight: 19,
    color: theme.color.ink,
    marginVertical: 6,
  },
}));
