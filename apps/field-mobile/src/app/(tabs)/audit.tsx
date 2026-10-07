import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator } from 'react-native';
import { AuditStart } from '../../components/audit-start';
import { EmptyState, Screen } from '../../components/ui';
import { listLocalUnits } from '../../lib/db/catalogue.repository';
import { useLocalDatabase } from '../../lib/db/provider';
import { useTheme } from '../../lib/theme';

/**
 * A Zone Leader's Audit tab. A Zone Leader belongs to exactly one Unit, so a Units list would
 * only ever have one row to tap: the tab opens that Unit's audit start directly, as a
 * Coordinator's My Unit tab opens their Unit's page (R-42).
 *
 * The Unit comes from the device's catalogue, not the session, so it opens with the radio off.
 */
export default function AuditTabScreen() {
  const theme = useTheme();
  const database = useLocalDatabase();
  const units = useQuery({ queryKey: ['local', 'units'], queryFn: () => listLocalUnits(database) });
  const unitId = units.data?.[0]?.id;

  if (unitId) return <AuditStart unitId={unitId} tab />;
  return (
    <Screen>
      {units.isLoading ? (
        <ActivityIndicator color={theme.color.ink} />
      ) : (
        <EmptyState
          title="No Unit"
          detail="Your account is not linked to a Unit yet. Sync the catalogue from Profile once it is."
        />
      )}
    </Screen>
  );
}
