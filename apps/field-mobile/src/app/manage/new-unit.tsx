import { ScrollView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { UnitForm } from '../../components/unit-form';
import { Screen } from '../../components/ui';
import { createThemedStyles } from '../../lib/theme';

export default function NewUnitScreen() {
  const styles = useStyles();
  const router = useRouter();
  return (
    <Screen>
      <Stack.Screen options={{ title: 'New Unit' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <UnitForm
          onSaved={(unit) => router.replace({ pathname: '/manage/unit/[unitId]', params: { unitId: unit.id } })}
          onCancel={() => router.back()}
        />
      </ScrollView>
    </Screen>
  );
}

const useStyles = createThemedStyles((theme) => ({
  content: { paddingBottom: theme.space.xl },
}));
