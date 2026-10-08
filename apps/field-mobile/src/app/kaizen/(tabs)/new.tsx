import { useState } from 'react';
import { useRouter } from 'expo-router';
import { KaizenForm } from '../../../components/kaizen-form';
import { Screen } from '../../../components/ui';

/**
 * New Kaizen. After Submit the form starts again blank (a fresh key), and the leader goes
 * to Overview, where the Kaizen they just sent is under "Awaiting review".
 */
export default function NewKaizen() {
  const router = useRouter();
  const [round, setRound] = useState(0);
  return (
    <Screen bare>
      <KaizenForm
        key={round}
        kaizenId={null}
        onSubmitted={() => {
          setRound((n) => n + 1);
          router.navigate('/kaizen/overview');
        }}
      />
    </Screen>
  );
}
