import { useRouter } from 'expo-router';
import { useLanguage } from '../lib/language-provider';
import { KAIZEN_STRINGS } from '../lib/kaizen-strings';
import { useSession } from '../lib/session';
import { HeaderAction } from './ui';

/**
 * "⇄ Switch": back to the module picker, on the header of every 5S and Kaizen tab. Absent
 * for a role without Kaizen, whose phone has only the one module and never shows the picker.
 */
export function ModuleSwitch() {
  const router = useRouter();
  const { can } = useSession();
  const { language } = useLanguage();
  if (!can('kaizen', 'read')) return null;
  const t = KAIZEN_STRINGS[language];
  return (
    <HeaderAction
      testID="module-switch"
      title={t.switchModule}
      accessibilityLabel={t.chooseWork}
      onPress={() => router.replace('/module')}
    />
  );
}
