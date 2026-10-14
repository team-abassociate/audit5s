import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Tabs, useLocalSearchParams, useRouter } from 'expo-router';
import type { Unit } from '@audit5s/contracts';
import { EmptyState, HeaderTitle, Screen } from '../../components/ui';
import { UnitDetail } from '../../components/unit-detail';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';

/**
 * A Coordinator's own Unit, as a tab (R-42). A Coordinator holds exactly one active Unit
 * (invariant M-1), so a Units list would only ever have one row to tap: the tab opens the
 * Unit's page directly, with the tab bar still under it.
 */
export default function MyUnitScreen() {
  const { scope } = useSession();
  const unitId = scope?.unitIds[0];
  // Overview's "Add a Zone" lands here with the add form open; the param is spent once read.
  const router = useRouter();
  const { add } = useLocalSearchParams<{ add?: string }>();
  const addZone = add === 'zone';
  useEffect(() => {
    if (addZone) router.setParams({ add: undefined });
  }, [addZone, router]);
  // The same query key as the page's own. The header names the Unit; the tab still says My Unit.
  const unit = useQuery({
    queryKey: ['unit', unitId],
    queryFn: () => api.get<Unit>(`/units/${unitId}`),
    enabled: unitId !== undefined,
  });

  return (
    <Screen>
      <Tabs.Screen options={{ headerTitle: () => <HeaderTitle>{unit.data?.name ?? 'My Unit'}</HeaderTitle> }} />
      {unitId ? (
        <UnitDetail unitId={unitId} addZone={addZone} />
      ) : (
        <EmptyState title="No Unit" detail="No Unit is assigned to you. A Super Admin gives a Coordinator their Unit." />
      )}
    </Screen>
  );
}
