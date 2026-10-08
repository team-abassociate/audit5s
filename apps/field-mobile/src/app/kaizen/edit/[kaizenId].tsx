import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { KaizenForm } from '../../../components/kaizen-form';
import { Screen } from '../../../components/ui';
import { KAIZEN_STRINGS } from '../../../lib/kaizen-strings';
import { useLanguage } from '../../../lib/language-provider';

/** A draft carried on, or a Kaizen sent back being fixed: the same form as New Kaizen. */
export default function EditKaizen() {
  const router = useRouter();
  const { kaizenId } = useLocalSearchParams<{ kaizenId: string }>();
  const { language } = useLanguage();
  return (
    <Screen bare>
      <Stack.Screen options={{ title: KAIZEN_STRINGS[language].kaizen }} />
      <KaizenForm kaizenId={kaizenId} onSubmitted={() => router.navigate('/kaizen/overview')} />
    </Screen>
  );
}
