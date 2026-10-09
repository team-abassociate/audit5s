import { useRouter } from 'expo-router';
import { useLanguage } from '../lib/language-provider';
import { KAIZEN_STRINGS } from '../lib/kaizen-strings';
import { useSession } from '../lib/session';
import { Button } from './ui';

/**
 * "⇄ Switch module": back to the module picker, on Profile (the initials in the top-left
 * corner open it from every 5S and Kaizen screen). Absent for a role without Kaizen, whose
 * phone has only the one module and never shows the picker.
 */
export function ModuleSwitch() {
  const router = useRouter();
  const { can } = useSession();
  const { language } = useLanguage();
  if (!can('kaizen', 'read')) return null;
  const t = KAIZEN_STRINGS[language];
  return (
    <Button
      testID="module-switch"
      title={t.switchModule}
      variant="secondary"
      accessibilityLabel={t.chooseWork}
      onPress={() => router.replace('/module')}
    />
  );
}
