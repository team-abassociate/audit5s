import { Alert, Platform, type AlertButton } from 'react-native';

/**
 * `Alert.alert` in a browser. react-native-web ships it as a no-op, so every confirmation in
 * the app ("Submit audit", "Abort this Zone", "Keep & log out") would silently do nothing.
 * The browser's own dialogs stand in: a message is `alert`, each action is one `confirm` in
 * turn — the first accepted runs, and declining them all is the cancel button.
 *
 * Runs on import, imported once in `src/app/_layout.tsx`, as `crypto-polyfill` is.
 */
// The DOM types are not in this project's lib, so the two dialogs are spelled out.
const browser = globalThis as unknown as { alert(text: string): void; confirm(text: string): boolean };

if (Platform.OS === 'web') {
  Alert.alert = (title: string, message?: string, buttons?: AlertButton[]) => {
    const text = message ? `${title}\n\n${message}` : title;
    const cancel = buttons?.find((button) => button.style === 'cancel');
    const actions = (buttons ?? []).filter((button) => button !== cancel);
    if (!cancel && actions.length <= 1) {
      browser.alert(text);
      actions[0]?.onPress?.();
      return;
    }
    const chosen = actions.find((button) =>
      browser.confirm(actions.length === 1 ? text : `${text}\n\nOK: ${button.text ?? 'OK'}`),
    );
    (chosen ?? cancel)?.onPress?.();
  };
}
