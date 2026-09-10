import { StyleSheet } from 'react-native';
import { EmptyState, Muted, Screen } from '../../components/ui';
import { theme } from '../../lib/theme';

/**
 * Audit history.
 *
 * The tab exists from Phase 1 because N1 fixes the navigation at three tabs and moving it
 * later would retrain users for nothing. It has no content yet by design: audits arrive in
 * Phase 3 and the offline store that backs this list in Phase 4. Saying so is better than
 * showing a plausible-looking empty list that will never populate.
 */
export default function HistoryScreen() {
  return (
    <Screen style={styles.screen}>
      <EmptyState
        title="No audits yet"
        detail="Completed and paused audits will appear here once auditing is enabled."
      />
      <Muted>Audit capture arrives in a later release.</Muted>
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { alignItems: 'center', justifyContent: 'center', gap: theme.space.md },
});
