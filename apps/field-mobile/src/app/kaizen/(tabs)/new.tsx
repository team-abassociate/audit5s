import { useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDayMonth } from '@audit5s/domain';
import { KaizenForm } from '../../../components/kaizen-form';
import { Button, Card, ConfirmAction, ErrorBanner, Screen, SectionHead } from '../../../components/ui';
import { discardLocalKaizen, listLocalKaizens } from '../../../lib/db/kaizen.repository';
import { useLocalDatabase } from '../../../lib/db/provider';
import { KAIZEN_STRINGS } from '../../../lib/kaizen-strings';
import { useLanguage } from '../../../lib/language-provider';
import { useSession } from '../../../lib/session';
import { useSync } from '../../../lib/sync/provider';
import { createThemedStyles } from '../../../lib/theme';

/**
 * New Kaizen. With drafts on the phone it first offers them (plans/kaizen-ux-plan.md 2.3):
 * carry one on, delete one, or start a new one, so a half-done Kaizen is not started twice.
 * After Submit the form starts again blank (a fresh key), and the leader goes to Overview,
 * which says the Kaizen was submitted.
 */
export default function NewKaizen() {
  const styles = useStyles();
  const router = useRouter();
  const database = useLocalDatabase();
  const queryClient = useQueryClient();
  const { sync } = useSync();
  const { can } = useSession();
  const { language } = useLanguage();
  const t = KAIZEN_STRINGS[language];
  const [round, setRound] = useState(0);
  const [starting, setStarting] = useState(false);

  const kaizens = useQuery({ queryKey: ['local', 'kaizens'], queryFn: () => listLocalKaizens(database) });
  const drafts = (kaizens.data ?? []).filter((kaizen) => kaizen.status === 'DRAFT');
  const discard = useMutation({
    mutationFn: (kaizenId: string) => discardLocalKaizen(database, kaizenId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['local'] });
      void sync();
    },
  });

  // The form's first save makes a draft. It stays open then: the choice is for arriving here.
  const formOpen = useRef(false);

  const again = () => {
    formOpen.current = false;
    setRound((n) => n + 1);
    setStarting(false);
  };

  if (kaizens.isLoading) return null;
  if (!starting && !formOpen.current && drafts.length > 0) {
    // One draft: carrying it on is the likely job. Several: starting afresh leads, above the list.
    const one = drafts.length === 1;
    const startNew = (
      <Button testID="kaizen-start-new" title={t.startNew} icon="add" variant={one ? 'secondary' : 'primary'} onPress={() => setStarting(true)} />
    );
    return (
      <Screen bare>
        <ScrollView contentContainerStyle={styles.content}>
          <SectionHead title={t.draftChoiceTitle(drafts.length)} />
          {one ? null : startNew}
          {drafts.map((draft) => (
            <Card key={draft.id}>
              <Text style={styles.draft}>
                {t.draftFrom(formatDayMonth(draft.createdAt), draft.sheet.theme || draft.sheet.machine || t.untitled)}
              </Text>
              {/* One above the other: beside Continue, the delete question ran off a phone's screen. */}
              <View style={styles.actions}>
                <Button
                  title={t.continueDraft}
                  icon="edit"
                  variant={one ? 'primary' : 'secondary'}
                  onPress={() => router.push({ pathname: '/kaizen/edit/[kaizenId]', params: { kaizenId: draft.id } })}
                />
                <ConfirmAction
                  title={t.deleteDraft}
                  icon="delete"
                  question={t.deleteDraftQuestion}
                  confirmLabel={t.deleteDraft}
                  keepLabel={t.keep}
                  busy={discard.isPending && discard.variables === draft.id}
                  onConfirm={() => discard.mutate(draft.id)}
                />
              </View>
            </Card>
          ))}
          <ErrorBanner message={discard.error?.message ?? null} />
          {one ? startNew : null}
        </ScrollView>
      </Screen>
    );
  }

  formOpen.current = true;
  return (
    <Screen bare>
      <KaizenForm
        key={round}
        kaizenId={null}
        onSubmitted={(kaizenId, resubmitted) => {
          again();
          // A reviewer's overview has no "submitted" slip: show the sheet.
          if (can('kaizen', 'review')) router.push({ pathname: '/kaizen/[kaizenId]', params: { kaizenId } });
          else router.navigate({ pathname: '/kaizen/overview', params: { submitted: kaizenId, ...(resubmitted ? { resubmitted: '1' } : {}) } });
        }}
        onDiscarded={() => {
          again();
          router.navigate('/kaizen/overview');
        }}
      />
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.xl, gap: theme.space.sm },
  draft: { fontFamily: theme.family.bold, fontSize: theme.font.base, lineHeight: 21, color: theme.color.ink, marginBottom: theme.space.sm },
  actions: { gap: theme.space.sm },
}));
