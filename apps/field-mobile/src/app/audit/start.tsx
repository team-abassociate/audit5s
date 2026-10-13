import { useLocalSearchParams } from 'expo-router';
import { AuditStart } from '../../components/audit-start';

/**
 * The + menu's "Start one myself": the Unit is picked here, not in the Units tab. `?type=`
 * preselects the kind (the Overview's cross-audit call sends `CROSS_5S`).
 */
export default function StartAuditScreen() {
  const { type } = useLocalSearchParams<{ type?: string }>();
  return <AuditStart type={type} />;
}
