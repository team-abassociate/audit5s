import { useEffect } from 'react';
import { Alert, Platform } from 'react-native';
import { backupFolder, chooseBackupFolder } from '../lib/capture/photo-backup';
import { useSession } from '../lib/session';
import { useSync } from '../lib/sync/provider';

/** Asked once per launch, so "Not now" is respected for the rest of the day's work. */
let askedThisLaunch = false;

/**
 * Asks an auditor without a photo folder to choose one (R-62). After a reinstall there is
 * none, which is the moment this matters: choosing the old folder again is what brings the
 * photos back, and the sync that follows sends them.
 */
export function PhotoBackupPrompt() {
  const { can } = useSession();
  const { sync } = useSync();
  const records = Platform.OS === 'android' && can('sync', 'push');

  useEffect(() => {
    if (!records || askedThisLaunch) return;
    askedThisLaunch = true;
    void backupFolder().then((folder) => {
      if (folder) return;
      Alert.alert(
        'Keep your photos in the gallery',
        'Every audit photo is also saved to a folder in this phone’s gallery, so it is not ' +
          'lost if the app is removed or reinstalled.\n\nOn the next screen, open "Pictures", ' +
          'create a folder named "Audit5S" and tap "Use this folder". After a reinstall, choose ' +
          'the same folder and any photo not yet uploaded is sent again.',
        [
          { text: 'Not now', style: 'cancel' },
          {
            text: 'Choose folder',
            onPress: () =>
              void chooseBackupFolder()
                .then((chosen) => (chosen ? sync() : undefined))
                .catch(() => undefined),
          },
        ],
      );
    });
  }, [records, sync]);

  return null;
}
