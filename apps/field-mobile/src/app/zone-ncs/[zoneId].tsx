import { Stack, useLocalSearchParams } from 'expo-router';
import { PreviousNcsList } from '../../components/previous-ncs';
import { Screen } from '../../components/ui';

/** R-79: the Zone's earlier NCs, opened from the Select Zone card. */
export default function ZoneNcsScreen() {
  const { zoneId } = useLocalSearchParams<{ zoneId: string }>();
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Earlier NCs' }} />
      <PreviousNcsList zoneId={zoneId} />
    </Screen>
  );
}
