/**
 * Whether an Android permission dialog is on screen.
 *
 * The system dialog is its own activity, so while it shows, React Native reports the app as
 * `background`. The root layout pauses an open audit on `background` (an answered phone call
 * must not leave an audit running), and so, before this existed, granting the camera from
 * inside an audit paused it and threw the auditor out to Overview mid-photograph.
 *
 * Every permission request goes through `whilePrompting`, and the pause-on-background
 * handler skips while one is open.
 */
let open = 0;

export function permissionPromptOpen(): boolean {
  return open > 0;
}

export async function whilePrompting<T>(ask: () => Promise<T>): Promise<T> {
  open += 1;
  try {
    return await ask();
  } finally {
    open -= 1;
  }
}
