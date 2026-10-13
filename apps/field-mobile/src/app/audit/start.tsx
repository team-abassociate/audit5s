import { useLocalSearchParams } from 'expo-router';
import { AuditStart } from '../../components/audit-start';

/**
 * The + menu's "Start one myself": the Unit is picked here, not in the Units tab. `?type=`
 * preselects the kind and `?zoneId=` the Zone (a cross-audit call sends both).
 */
export default function StartAuditScreen() {
  const { type, zoneId } = useLocalSearchParams<{ type?: string; zoneId?: string }>();
  return <AuditStart type={type} zoneId={zoneId} />;
}
