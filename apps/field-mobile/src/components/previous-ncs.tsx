import { useState } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import type { PreviousNonconformities, PreviousNonconformity } from '@audit5s/contracts';
import { api } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/format';
import { createThemedStyles } from '../lib/theme';
import { KaizenPhotoViewer } from './kaizen-photo-viewer';
import { Button, Card, CardHeader, Chip, EmptyState, ErrorBanner, Muted } from './ui';

/** R-79: the Zone's last finished audit's NCs. Online only: they live on the server. */
export function usePreviousNcs(zoneId: string | null) {
  return useQuery({
    queryKey: ['previous-ncs', zoneId],
    queryFn: () => api.get<PreviousNonconformities>(`/zones/${zoneId}/previous-nonconformities`),
    enabled: Boolean(zoneId),
  });
}

/** On the Select Zone card: the figures, and a tap to see each NC and its photos. */
export function PreviousNcsButton({ zoneId }: { zoneId: string }) {
  const router = useRouter();
  const ncs = usePreviousNcs(zoneId);
  if (ncs.isLoading) return <Muted>Loading the earlier NCs…</Muted>;
  if (ncs.error || !ncs.data) return <Muted>Earlier NCs need a connection.</Muted>;
  const { raised, closed, open } = ncs.data;
  return (
    <Button
      icon="fact-check"
      variant="secondary"
      title={
        ncs.data.auditId
          ? `Earlier NCs: ${raised} raised · ${closed} closed · ${open} open`
          : 'Earlier NCs: none — first audit of this Zone'
      }
      disabled={!ncs.data.auditId}
      onPress={() => router.push({ pathname: '/zone-ncs/[zoneId]', params: { zoneId } })}
    />
  );
}

/** The list behind the button: each NC, its photo, and once closed, before and after. */
export function PreviousNcsList({ zoneId }: { zoneId: string }) {
  const styles = useStyles();
  const ncs = usePreviousNcs(zoneId);
  const [viewing, setViewing] = useState<{ item: PreviousNonconformity; kind: 'BEFORE' | 'AFTER' } | null>(null);

  if (ncs.isLoading) return <Muted>Loading…</Muted>;
  if (ncs.error || !ncs.data) return <ErrorBanner message="Could not load the earlier NCs. Check the connection." />;
  const data = ncs.data;
  if (!data.auditId || data.items.length === 0) {
    return <EmptyState title="No earlier NCs" detail="The Zone's last audit raised none." />;
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Muted>
        Last audit {data.auditDate ? formatDate(data.auditDate) : ''}: {data.raised} raised · {data.closed} closed ·{' '}
        {data.open} open
      </Muted>
      {data.items.map((item) => {
        const isClosed = item.status === 'VERIFIED';
        return (
          <Card key={item.id}>
            <CardHeader title={item.questionNo ? `Q${item.questionNo}. ${item.text}` : item.text} />
            <Chip tone={isClosed ? 'ok' : 'warn'}>{isClosed ? 'Closed' : 'Open'}</Chip>
            {isClosed && item.closedByName ? (
              <Muted>
                Closed by {item.closedByName}
                {item.closedAt ? `, ${formatDateTime(item.closedAt)}` : ''}
              </Muted>
            ) : null}
            <View style={styles.photos}>
              <Photo label="Before" uri={item.beforePhotoUrl} onPress={() => setViewing({ item, kind: 'BEFORE' })} />
              {isClosed ? (
                <Photo label="After" uri={item.afterPhotoUrl} onPress={() => setViewing({ item, kind: 'AFTER' })} />
              ) : null}
            </View>
          </Card>
        );
      })}
      <KaizenPhotoViewer
        photos={{ BEFORE: viewing?.item.beforePhotoUrl, AFTER: viewing?.item.afterPhotoUrl }}
        kind={viewing?.kind ?? null}
        onClose={() => setViewing(null)}
      />
    </ScrollView>
  );
}

function Photo({ label, uri, onPress }: { label: string; uri: string | null; onPress: () => void }) {
  const styles = useStyles();
  if (!uri) return <Muted>{label}: no photo</Muted>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} photo`} onPress={onPress} style={styles.photoBox}>
      <Image source={{ uri }} style={styles.photo} resizeMode="cover" />
      <Muted>{label}</Muted>
    </Pressable>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { padding: theme.space.md, paddingBottom: theme.space.xl, gap: theme.space.sm },
  photos: { flexDirection: 'row' as const, gap: theme.space.sm, marginTop: theme.space.sm },
  photoBox: { flex: 1, gap: 4 },
  photo: { width: '100%' as const, aspectRatio: 1, borderRadius: theme.radius.control },
}));
