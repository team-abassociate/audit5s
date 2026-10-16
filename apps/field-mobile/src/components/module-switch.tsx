import { useRouter } from 'expo-router';
import { useLanguage } from '../lib/language-provider';
import { KAIZEN_STRINGS } from '../lib/kaizen-strings';
import { saveModule, type AppModule } from '../lib/secure-storage';
import { useSession } from '../lib/session';
import { Button } from './ui';

/**
 * Opens a module and remembers it for this person: the picker's tiles and the sync bar's
 * 5S | KAIZEN switch both go through here.
 */
export function useOpenModule() {
  const router = useRouter();
  const { user } = useSession();
  return (module: AppModule) => {
    if (user) void saveModule(user.id, module);
    router.replace(module === 'kaizen' ? '/kaizen/overview' : '/overview');
  };
}

/**
 * "Switch module": back to the module picker, on Profile (the 5S | KAIZEN switch in the sync
 * bar is the one-tap way). Absent for a role without Kaizen, whose phone has only the one
 * module and never shows the picker.
 */
export function ModuleSwitch() {
  const router = useRouter();
  const { can } = useSession();
  const { language } = useLanguage();
  if (!can('kaizen', 'read')) return null;
  const t = KAIZEN_STRINGS[language];
  return (
    <Button icon="swap-horiz"
      testID="module-switch"
      title={t.switchModule}
      variant="secondary"
      accessibilityLabel={t.chooseWork}
      onPress={() => router.replace('/module')}
    />
  );
}
