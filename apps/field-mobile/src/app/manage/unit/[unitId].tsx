import { useQuery } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import type { Unit } from '@audit5s/contracts';
import { Screen } from '../../../components/ui';
import { UnitDetail } from '../../../components/unit-detail';
import { api } from '../../../lib/api';

/**
 * One Unit, opened from a Super Admin's Units list. The page itself is `UnitDetail`, shared
 * with the Coordinator's My Unit tab (R-42); this route only names the header.
 */
export default function ManageUnitScreen() {
  const { unitId } = useLocalSearchParams<{ unitId: string }>();
  // The same query key as the page's own, so this is the one request, not a second.
  const unit = useQuery({ queryKey: ['unit', unitId], queryFn: () => api.get<Unit>(`/units/${unitId}`) });

  return (
    <Screen>
      <Stack.Screen options={{ title: unit.data?.name ?? 'Unit' }} />
      <UnitDetail unitId={unitId} />
    </Screen>
  );
}
