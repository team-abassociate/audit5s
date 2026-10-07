import { useLocalSearchParams } from 'expo-router';
import { AuditStart } from '../../components/audit-start';

/** A Unit opened from a Units list: the way into an audit. See `audit-start.tsx`. */
export default function UnitStartScreen() {
  const { unitId } = useLocalSearchParams<{ unitId: string }>();
  return <AuditStart unitId={unitId} />;
}
