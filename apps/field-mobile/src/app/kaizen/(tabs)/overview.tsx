import { EmptyState, Screen } from '../../../components/ui';

/** Kaizen Overview. Built in step 5 (leader) and step 6 (Coordinator). */
export default function KaizenOverview() {
  return (
    <Screen>
      <EmptyState title="Kaizen" detail="The Kaizen screens arrive in the next build step." />
    </Screen>
  );
}
