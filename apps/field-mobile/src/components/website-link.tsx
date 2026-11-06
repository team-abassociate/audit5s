import { Platform } from 'react-native';
import { Button } from './ui';

// The DOM types are not in this project's lib, so the one call is spelled out.
const browser = globalThis as unknown as { location: { assign(url: string): void } };

/**
 * R-86: a phone opening the portal is sent here, so `/field` offers the way back, for what only
 * the website has. In a browser only: the installed app has no website behind it.
 */
export function WebsiteLink() {
  if (Platform.OS !== 'web') return null;
  return <Button icon="open-in-new" title="Use the website" variant="secondary" onPress={() => browser.location.assign('/?website=1')} />;
}
