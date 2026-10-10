import { AndroidHaptics, performAndroidHapticsAsync } from 'expo-haptics';

/**
 * The module's five haptic moments (plans/kaizen-ux-plan.md 4.4), and nowhere else: never on a
 * tick, a segment, a scroll, a tab or Next. Each fires in the handler that changes what is on
 * screen, and is never the only signal: many phones have haptics off, and that must lose nothing.
 *
 * Android's own haptic feedback, not `notificationAsync`/`impactAsync`: those drive the
 * vibrator directly, ignore the phone's "touch feedback" setting and need VIBRATE. This
 * follows the setting, as 4.4 asks. The plan's calls map one to one: Success → Confirm,
 * Error → Reject, Light → Virtual_Key, Medium → Long_Press.
 */
function feel(type: AndroidHaptics) {
  return () => void performAndroidHapticsAsync(type).catch(() => undefined);
}

export const haptic = {
  /** Submit accepted; pairs with the "Kaizen submitted" slip. */
  submitted: feel(AndroidHaptics.Confirm),
  /** Submit refused; pairs with the banner and the red box. */
  refused: feel(AndroidHaptics.Reject),
  /** A Kaizen photo taken; pairs with the preview appearing. */
  captured: feel(AndroidHaptics.Virtual_Key),
  /** Remove photo, delete draft, Reject: pairs with what it removes. */
  destroyed: feel(AndroidHaptics.Long_Press),
  /** A review decision recorded; pairs with the "Approved KZ-…" slip. */
  reviewed: feel(AndroidHaptics.Confirm),
} as const;
